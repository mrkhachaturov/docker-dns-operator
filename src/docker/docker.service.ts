import { Inject, Injectable, LoggerService } from '@nestjs/common';
import type { Readable } from 'stream';
import Docker from 'dockerode';
import { ConfigService } from '@nestjs/config';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ConsoleLoggerService } from '../logger.service';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry } from '../dto/dnsns-entry';
import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { IConfiguration } from '../app.configuration';
import { NestedError } from '../errors/nested-error';
import { DockerFactory } from './docker.factory';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsAaaaEntry } from '../dto/dnsaaaa-entry';
import { DnsBaseCloudflareEntry } from '../dto/dnsbase-cloudflare-entry';
import { getLogClassDecorator } from '../utility.functions';
import {
  normalizeProviders,
  normalizeProviderOptions,
} from './label-normalizer';
import { DockerSource } from './docker-source';

let loggerPointer: LoggerService;
const LogDecorator = getLogClassDecorator(() => loggerPointer);

/**
 * Possibe states of the docker service
 */
export enum States {
  Unintialized,
  Initialized,
}

/**
 * Adapter over dockerode to expose a minimal API for the purpose of this application.
 * Responsible for any interaction with dockerode, including:
 * - Initializing dockerode
 * - Encapsulating exceptions
 * - Querying for containers with labels based on our criteria
 * - Deserializing and validating the JSON labels
 */
@LogDecorator()
@Injectable()
export class DockerService {
  // Set in initialize() before any other method may legally run; the state
  // guard above each public method enforces it. The definite-assignment
  // assertion lets the compiler trust that contract.
  private docker!: Docker;

  private dockerLabel!: string;

  private preserveStopped!: boolean;

  // Resolved lazily on the first getSources() call. undefined = not yet
  // resolved; true/false = the result of explicit env or auto-detect.
  private swarmMode?: boolean;

  // Backoff between event-stream reconnect attempts. Exposed as a field so
  // tests can shrink it without sleeping for real seconds. Production uses 5 s,
  // mirroring the upstream Docker SDK reference implementation.
  private reconnectDelayMs = 5000;

  private state = States.Unintialized;

  constructor(
    @Inject() private readonly dockerFactory: DockerFactory,
    @Inject() private readonly configService: ConfigService<IConfiguration>,
    private loggerService: ConsoleLoggerService,
  ) {
    loggerPointer = this.loggerService;
  }

  /**
   * Initializes the class by fetching the docker instance.
   * Swarm-mode is resolved lazily on the first getSources() call so this
   * stays a synchronous boot step.
   *
   * @throws { Error } If service is already initialized
   * @throws { NestedError } throws if err initializing docker
   */
  initialize(): void {
    if (this.state !== States.Unintialized)
      throw new Error(
        'DockerService, initialize: Failed initializing docker service, service alread initialized',
      );

    try {
      this.docker = this.dockerFactory.get();
    } catch (error) {
      throw new NestedError(
        'DockerService, initialize: Failed initializing docker service',
        error,
      );
    }

    this.dockerLabel = this.configService.get('ENTRY_IDENTIFIER', {
      infer: true,
    }) as string;
    this.preserveStopped = this.configService.get('PRESERVE_STOPPED', {
      infer: true,
    }) as boolean;

    this.state = States.Initialized;
  }

  /**
   * Auto-detects whether to query swarm services (listServices) or local
   * containers (listContainers). Probes the daemon via `docker info` exactly
   * once and caches the result.
   *
   * Decision matrix:
   *   - Swarm.LocalNodeState === 'active' AND ControlAvailable === true
   *     (we're a manager and can call listServices) → swarm mode.
   *   - inactive / locked / worker-only → container mode.
   *   - docker.info() itself failed → THROW. We deliberately do NOT guess a
   *     mode here. Guessing `container` on a failed probe was the
   *     fail-open-to-delete root cause (issue #12): a transient socket outage
   *     at boot latched the operator into container mode, getSources then read
   *     zero service labels in a Swarm stack, and reconcile pruned every owned
   *     record. By throwing AND leaving swarmMode unresolved we (1) make the
   *     caller skip this cycle instead of reconciling against a phantom empty
   *     desired set, and (2) re-probe on the next tick so a recovered socket
   *     self-heals without an operator restart.
   *
   * Implication for operators: if you want one operator instance to see DNS
   * labels across the whole cluster, run it on a manager node. A worker-node
   * operator only sees containers running on that worker.
   *
   * @throws {NestedError} If docker.info() fails (probe inconclusive)
   */
  private async resolveSwarmMode(): Promise<boolean> {
    if (this.swarmMode !== undefined) return this.swarmMode;

    let info: {
      Swarm?: { LocalNodeState?: string; ControlAvailable?: boolean };
    };
    try {
      info = (await this.docker.info()) as typeof info;
    } catch (error) {
      // Do NOT cache a result — leave swarmMode undefined so the next tick
      // re-probes. Surface the failure so the caller aborts this cycle.
      this.loggerService.warn(
        `DockerService, resolveSwarmMode: docker.info() probe failed; skipping this cycle and will re-probe: ${
          (error as Error).message
        }`,
      );
      throw new NestedError(
        'DockerService, resolveSwarmMode: docker.info() probe failed',
        error,
      );
    }

    const state = info.Swarm?.LocalNodeState ?? 'inactive';
    const isManager = info.Swarm?.ControlAvailable === true;
    this.loggerService.log(
      `DockerService, resolveSwarmMode: LocalNodeState=${state} ControlAvailable=${isManager} → ${
        state === 'active' && isManager ? 'swarm' : 'container'
      } mode`,
    );
    this.swarmMode = state === 'active' && isManager;

    return this.swarmMode;
  }

  /**
   * Returns all sources (containers or swarm services) that have the DNS label.
   * In container mode: calls listContainers.
   * In swarm mode: calls listServices and maps each to DockerSource.
   * @returns Promise resolving to DockerSource array
   * @throws {Error} If service hasn't been initialized
   * @throws {NestedError} If docker throws an error
   */
  async getSources(): Promise<DockerSource[]> {
    if (this.state !== States.Initialized)
      throw new Error(
        'DockerService, getSources: not initialized, must call initialize',
      );

    try {
      const swarm = await this.resolveSwarmMode();
      if (!swarm) {
        return await this.docker.listContainers({
          all: this.preserveStopped,
          filters: JSON.stringify({ label: [this.dockerLabel] }),
        });
      }

      // Swarm mode: listServices uses a raw object filter (NOT JSON.stringify).
      // status: true asks the daemon to populate ServiceStatus.RunningTasks /
      // DesiredTasks — without it the field is nil and we can't tell a healthy
      // service from a degraded/scaled-down one.
      const services = await this.docker.listServices({
        filters: { label: [this.dockerLabel] },
        status: true,
      });

      // Only use Spec.Labels (set by deploy.labels in compose). Treat a service
      // with RunningTasks == 0 the same way listContainers treats an `exited`
      // container: include only when PRESERVE_STOPPED=true. Services missing
      // from listServices entirely (docker stack rm / docker service rm) are
      // the analog of `docker rm` and always drop out.
      const sources = services
        .map((service): DockerSource | null => {
          const labels = service.Spec?.Labels;
          if (!labels) {
            this.loggerService.warn(
              `DockerService, getSources: service ${service.ID} has no labels, skipping`,
            );
            return null;
          }
          const running = service.ServiceStatus?.RunningTasks ?? 0;
          if (running === 0 && !this.preserveStopped) {
            this.loggerService.debug(
              `DockerService, getSources: skipping service ${service.Spec?.Name ?? service.ID} (RunningTasks=0, PRESERVE_STOPPED=false)`,
            );
            return null;
          }
          return { Id: service.ID, Labels: labels };
        })
        .filter((source): source is DockerSource => source !== null);
      return sources;
    } catch (error) {
      throw new NestedError(
        'DockerService, getSources: Failed getting sources',
        error,
      );
    }
  }

  /**
   * Finds containers with the labels associated with this instance of the docker-dns-operator project.
   * Returns the containers information verbatim.
   * @returns Promise resolving to the docker containers
   * @throws {Error} If serivce hasn't been initialized
   * @throws {NestedError} If docker throws an error fetching containers
   * */
  async getContainers(): Promise<Docker.ContainerInfo[]> {
    if (this.state !== States.Initialized)
      throw new Error(
        'DockerService, getContainers: not initialized, must call initialize',
      );
    try {
      return await this.docker.listContainers({
        all: this.preserveStopped,
        filters: JSON.stringify({ label: [this.dockerLabel] }),
      });
    } catch (error) {
      throw new NestedError(
        'DockerService, getContainers: Failed getting containers',
        error,
      );
    }
  }

  /**
   * Subscribe to Docker daemon events that may have changed the set of
   * labelled containers/services. The callback is invoked once per event
   * (no arguments — the caller is expected to re-scan via getSources).
   *
   * Filters mirror the upstream Docker SDK reference pattern: container
   * create/start/stop/die/destroy, plus service create/update/remove when
   * we're a Swarm manager. We deliberately do NOT label-filter the stream
   * — a missed destroy event because the label was already gone is worse
   * than the cost of an extra reconcile pass.
   *
   * Robust to:
   *  - long-lived stream errors / end (auto-reconnects after reconnectDelayMs;
   *    coalesces concurrent error+end into a single reconnect)
   *  - getEvents() rejection (treated like a stream error)
   *  - unsubscribe before the initial connect resolves (aborts cleanly)
   *  - NDJSON chunks split across or merged in transport (line-buffered)
   *
   * @returns An unsubscribe function. Idempotent.
   */
  async subscribeToEvents(callback: () => void): Promise<() => void> {
    if (this.state !== States.Initialized)
      throw new Error(
        'DockerService, subscribeToEvents: not initialized, must call initialize',
      );

    const state = {
      stopped: false,
      currentStream: undefined as Readable | undefined,
      reconnectTimer: undefined as NodeJS.Timeout | undefined,
    };

    const scheduleReconnect = (): void => {
      if (state.stopped || state.reconnectTimer) return;
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = undefined;
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        connect();
      }, this.reconnectDelayMs);
    };

    const parseLine = (line: string): void => {
      if (line.trim().length === 0) return;
      try {
        JSON.parse(line);
      } catch {
        return;
      }
      if (state.stopped) return;
      try {
        callback();
      } catch (err) {
        this.loggerService.warn(
          `DockerService, subscribeToEvents: callback threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    const connect = async (): Promise<void> => {
      if (state.stopped) return;

      let filters: { type: string[]; event: string[] };
      try {
        const swarm = await this.resolveSwarmMode();
        if (state.stopped) return;
        filters = swarm
          ? {
              type: ['container', 'service'],
              event: [
                'create',
                'start',
                'stop',
                'die',
                'destroy',
                'update',
                'remove',
              ],
            }
          : {
              type: ['container'],
              event: ['create', 'start', 'stop', 'die', 'destroy'],
            };
      } catch (err) {
        this.loggerService.warn(
          `DockerService, subscribeToEvents: swarm-mode probe failed, retrying in ${this.reconnectDelayMs}ms: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        scheduleReconnect();
        return;
      }

      let stream: Readable;
      try {
        stream = (await this.docker.getEvents({
          filters: JSON.stringify(filters),
        })) as unknown as Readable;
      } catch (err) {
        if (state.stopped) return;
        this.loggerService.warn(
          `DockerService, subscribeToEvents: failed to open events stream, retrying in ${this.reconnectDelayMs}ms: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        scheduleReconnect();
        return;
      }

      if (state.stopped) {
        stream.destroy();
        return;
      }

      state.currentStream = stream;
      let buffer = '';
      let reconnectArmed = false;
      const armReconnect = (cause: string): void => {
        if (reconnectArmed || state.stopped) return;
        reconnectArmed = true;
        this.loggerService.warn(
          `DockerService, subscribeToEvents: event stream ${cause}, reconnecting in ${this.reconnectDelayMs}ms`,
        );
        state.currentStream = undefined;
        scheduleReconnect();
      };

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          parseLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
        }
      });
      stream.on('error', (err: Error) => {
        armReconnect(`errored (${err.message})`);
      });
      stream.on('end', () => {
        armReconnect('ended');
      });
    };

    // Fire-and-forget the initial connect so unsubscribe is available
    // synchronously to the caller.
    connect();

    return () => {
      if (state.stopped) return;
      state.stopped = true;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = undefined;
      }
      if (state.currentStream) {
        state.currentStream.destroy();
        state.currentStream = undefined;
      }
    };
  }

  /**
   * Contains behavior to deserialize the labels on the containers.
   * Converts to appropriate type and validates
   * @param {DockerSource[]} sources sources with labels to deserialize
   * @returns {DnsbaseEntry[]} deserialized labels
   * @throws {Error} If serivce hasn't been initialized
   */
  @LogDecorator({ level: 'debug' })
  extractDNSEntries(sources: DockerSource[]): DnsbaseEntry[] {
    if (this.state !== States.Initialized)
      throw new Error(
        'DockerService, extractDNSEntries: not initialized, must call initialize',
      );

    const allEntries: DnsbaseEntry[] = [];
    sources.forEach((source) => {
      try {
        // try to parse the JSON
        const entries = JSON.parse(
          source.Labels[this.dockerLabel],
        ) as DnsBaseCloudflareEntry[];
        if (!Array.isArray(entries)) {
          this.loggerService.warn(
            `DockerService, extractDNSEntries: source with id ${source.Id} has an unrecognised shape, check the values`,
          );
          return;
        }
        if (entries.length === 0) {
          this.loggerService.warn(
            `DockerService, extractDNSEntries: source with id ${source.Id} has empty array for a label and has been ignored`,
          );
          return;
        }
        entries.forEach((entry) => {
          if (entry.id !== undefined) {
            this.loggerService.warn(
              `DockerService, extractDNSEntries: source with id ${source.Id} has 'id' within it's JSON label, please remove it`,
            );
            return;
          }

          const rawEntry = entry as Record<string, unknown>;

          // Normalize providers
          const providers = normalizeProviders(
            rawEntry.provider,
            rawEntry.providers,
          );
          if (providers === null) {
            this.loggerService.warn(
              `DockerService, extractDNSEntries: source ${source.Id} has malformed providers field, entry skipped`,
            );
            return;
          }

          // Normalize providerOptions (null = malformed, skip entry)
          const providerOptions = normalizeProviderOptions(rawEntry);
          if (providerOptions === null) {
            this.loggerService.warn(
              `DockerService, extractDNSEntries: source ${source.Id} has malformed proxy field, entry skipped`,
            );
            return;
          }

          // Strip raw proxy/provider fields before instantiation
          const {
            proxy,
            provider,
            providers: rawProvidersField,
            providerOptions: rawProviderOptionsField,
            ...restEntry
          } = rawEntry;

          // Cast to appropriate type
          let instance: DnsbaseEntry;
          switch (entry.type) {
            case DNSTypes.A:
              instance = plainToInstance(DnsaEntry, {
                ...restEntry,
                providers,
                ...(providerOptions ? { providerOptions } : {}),
              });
              break;
            case DNSTypes.AAAA:
              instance = plainToInstance(DnsAaaaEntry, {
                ...restEntry,
                providers,
                ...(providerOptions ? { providerOptions } : {}),
              });
              break;
            case DNSTypes.CNAME:
              instance = plainToInstance(DnsCnameEntry, {
                ...restEntry,
                providers,
                ...(providerOptions ? { providerOptions } : {}),
              });
              break;
            case DNSTypes.MX:
              instance = plainToInstance(DnsMxEntry, {
                ...restEntry,
                providers,
                ...(providerOptions ? { providerOptions } : {}),
              });
              break;
            case DNSTypes.NS:
              instance = plainToInstance(DnsNsEntry, {
                ...restEntry,
                providers,
                ...(providerOptions ? { providerOptions } : {}),
              });
              break;
            case DNSTypes.Unsupported:
              this.loggerService.warn(
                `DockerService, extractDNSEntries: source with id ${source.Id} is using 'Unsupported' type, it will be ignored`,
              );
              return;
            default:
              this.loggerService.warn(
                `DockerService, extractDNSEntries: source with id ${source.Id} has an unrecognised shape, check the values`,
              );
              return;
          }
          // validate
          const errors = validateSync(instance);
          // warn and ignore if any errors
          if (errors.length !== 0) {
            this.loggerService.warn(
              `DockerService, extractDNSEntries: source with id ${source.Id} has validation errors`,
              errors,
            );
            return;
          }
          allEntries.push(instance);
        });
      } catch (error) {
        // failed to parse the JSON
        this.loggerService.warn(
          `DockerService, extractDNSEntries: source with id ${source.Id} has a non JSON formatted label`,
        );
      }
    });

    return allEntries;
  }
}
