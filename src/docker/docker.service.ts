import { Inject, Injectable, LoggerService } from '@nestjs/common';
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
import { DnsBaseCloudflareEntry } from '../dto/dnsbase-entry.spec';
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
  private docker: Docker;

  private dockerLabel: string;

  private preserveStopped: boolean;

  // Resolved lazily on the first getSources() call. undefined = not yet
  // resolved; true/false = the result of explicit env or auto-detect.
  private swarmMode?: boolean;

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
   *   - Anything else (inactive / locked / worker-only / docker.info failed)
   *     → container mode, reading whatever local containers we can see.
   *
   * Implication for operators: if you want one operator instance to see DNS
   * labels across the whole cluster, run it on a manager node. A worker-node
   * operator only sees containers running on that worker.
   */
  private async resolveSwarmMode(): Promise<boolean> {
    if (this.swarmMode !== undefined) return this.swarmMode;

    try {
      const info = (await this.docker.info()) as {
        Swarm?: { LocalNodeState?: string; ControlAvailable?: boolean };
      };
      const state = info.Swarm?.LocalNodeState ?? 'inactive';
      const isManager = info.Swarm?.ControlAvailable === true;
      this.loggerService.log(
        `DockerService, resolveSwarmMode: LocalNodeState=${state} ControlAvailable=${isManager} → ${
          state === 'active' && isManager ? 'swarm' : 'container'
        } mode`,
      );
      this.swarmMode = state === 'active' && isManager;
    } catch (error) {
      this.loggerService.warn(
        `DockerService, resolveSwarmMode: docker.info() failed, falling back to container mode: ${
          (error as Error).message
        }`,
      );
      this.swarmMode = false;
    }

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
