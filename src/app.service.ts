import { Injectable, LoggerService, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isNumber } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ProviderRegistry } from './providers/provider-registry.service';
import { DockerService } from './docker/docker.service';
import { computeSetDifference } from './app.functions';
import { DnsbaseEntry } from './dto/dnsbase-entry';
import { DnsaEntry, isDnsAEntry } from './dto/dnsa-entry';
import { getLogClassDecorator } from './utility.functions';
import { ConsoleLoggerService } from './logger.service';
import { State as CronState } from './cron/cron.service';
import { DdnsService } from './ddns/ddns.service';

let loggerPointer: LoggerService;
const LogDecorator = getLogClassDecorator(() => loggerPointer);

/**
 * Possible states of AppService
 */
export enum State {
  Uninitialized,
  Initialized,
}

/**
 * Drives the reconcile loop. Two triggers:
 *   1. Docker daemon events (container create/start/stop/die/destroy and, on
 *      Swarm managers, service create/update/remove) — the primary path.
 *   2. A long fallback timer (EXECUTION_FREQUENCY_SECONDS) as a safety net
 *      against missed events and to drive DDNS IP propagation, which has no
 *      Docker event of its own.
 *
 * Both feed a single non-reentrant `scheduleReconcile()` that debounces
 * (RECONCILE_DEBOUNCE_MS, default 500) to coalesce bursts of events, and
 * queues exactly one follow-up if events arrive during an in-flight job.
 */
@LogDecorator()
@Injectable()
export class AppService implements OnModuleDestroy {
  private state = State.Uninitialized;

  private stopped = false;

  private unsubscribeEvents?: () => void;

  private fallbackTimer?: NodeJS.Timeout;

  private debounceTimer?: NodeJS.Timeout;

  private reconcileInProgress = false;

  private reconcilePending = false;

  /**
   * Fetches the EXECUTION_FREQUENCY_SECONDS — the fallback reconcile interval.
   * Docker events are the primary trigger; this timer is a safety net for
   * missed events and the only thing that propagates DDNS IP changes.
   */
  get ExecutionFrequencySeconds(): number {
    const executionIntervalSeconds: number | undefined =
      this.configService.get<number>('EXECUTION_FREQUENCY_SECONDS', {
        infer: true,
      });
    if (!isNumber(executionIntervalSeconds))
      throw new Error(
        `AppService, ExecutionIntervalSeconds: Unreachable error, EXECUTION_FREQUENCY_SECONDS isn't a number (${executionIntervalSeconds})`,
      );
    return executionIntervalSeconds;
  }

  private get reconcileDebounceMs(): number {
    const ms =
      this.configService.get<number>('RECONCILE_DEBOUNCE_MS', {
        infer: true,
      }) ?? 500;
    return ms;
  }

  constructor(
    private providerRegistry: ProviderRegistry,
    private dockerService: DockerService,
    private configService: ConfigService,
    private ddnsService: DdnsService,
    protected loggerService: ConsoleLoggerService,
  ) {
    loggerPointer = this.loggerService;
  }

  /**
   * Initialize AppService.
   * Initializes the provider registry and Docker service.
   */
  initialize() {
    if (this.state === State.Initialized)
      throw Error(
        'AppService, initialize: Already initialized, but attempted to initialize again',
      );

    this.providerRegistry.initialize();
    this.dockerService.initialize();
    this.state = State.Initialized;
  }

  /**
   * Start the reactive reconcile loop. Subscribes to Docker events FIRST
   * (so we don't miss anything that happens during initial sync), then
   * arms the fallback timer, then schedules the initial reconcile through
   * the same debouncer all subsequent triggers go through.
   */
  async start(): Promise<void> {
    if (this.stopped)
      throw new Error('AppService, start: cannot start after stop');

    this.loggerService.log(
      `AppService: starting reactive reconcile (debounce ${this.reconcileDebounceMs}ms, fallback every ${this.ExecutionFrequencySeconds}s)`,
    );

    this.unsubscribeEvents = await this.dockerService.subscribeToEvents(() => {
      this.scheduleReconcile();
    });

    this.armFallback();
    this.scheduleReconcile();
  }

  /**
   * Tear down the reconcile loop. Safe to call multiple times. After stop,
   * no further reconciles will be scheduled even if an in-flight job
   * completes — its post-run drain checks `stopped`.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = undefined;
    }
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.reconcilePending = false;
  }

  onModuleDestroy(): void {
    this.stop();
  }

  private armFallback(): void {
    if (this.stopped) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = undefined;
      if (this.stopped) return;
      this.scheduleReconcile();
      this.armFallback();
    }, this.ExecutionFrequencySeconds * 1000);
  }

  private scheduleReconcile(): void {
    if (this.stopped) return;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.runReconcile();
    }, this.reconcileDebounceMs);
  }

  private async runReconcile(): Promise<void> {
    if (this.stopped) return;
    if (this.reconcileInProgress) {
      this.reconcilePending = true;
      return;
    }
    this.reconcileInProgress = true;
    try {
      await this.job();
    } catch (err) {
      this.loggerService.error(
        `AppService, runReconcile: job threw, continuing — next trigger will retry`,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    } finally {
      this.reconcileInProgress = false;
      if (!this.stopped && this.reconcilePending) {
        this.reconcilePending = false;
        this.scheduleReconcile();
      }
    }
  }

  /**
   * Fetches labels from docker.
   * For each provider: fetches records, computes diff, applies changes.
   */
  @LogDecorator({ level: 'debug' })
  async job() {
    if (this.state === State.Uninitialized)
      throw new Error(
        'AppService, synchronize: Not initialized, cannot synchronize. Call initialize first',
      );

    const containers = await this.dockerService.getSources();
    let allDockerEntries =
      await this.dockerService.extractDNSEntries(containers);

    // DDNS resolution — provider-agnostic, applied before per-provider filtering
    if (this.ddnsService.isDdnsRequired(allDockerEntries)) {
      if (this.ddnsService.getState() === CronState.Stopped)
        await this.ddnsService.start();
      const address = this.ddnsService.getIPAddress();
      if (address === undefined) {
        this.loggerService
          .warn(`DDNS, IPAddress has yet to be fetched successfully. DDNS records have been filtered out.
          They'll be added in automatically once an IPAddress has been fetched.`);
        allDockerEntries = allDockerEntries.filter(
          (entry) => !(isDnsAEntry(entry) && entry.address === 'DDNS'),
        );
      } else {
        allDockerEntries = allDockerEntries.map((entry) => {
          if (!isDnsAEntry(entry)) return entry;
          if (entry.address !== 'DDNS') return entry;
          return plainToInstance(DnsaEntry, { ...entry, address });
        });
      }
    } else if (this.ddnsService.getState() === CronState.Started)
      await this.ddnsService.stop();

    // Strict per-entry provider validation. An entry with any unknown
    // provider name in its `providers: [...]` list (other than the special
    // `"all"` token) is rejected loudly with a per-entry ERROR log and
    // skipped for the rest of this cycle. Other entries reconcile as
    // normal. We never silently fall back or guess what a typo meant —
    // see docs/sidecar-architecture.md "Naming and registration".
    const knownKeys = new Set(
      this.providerRegistry.getAll().map((p) => p.providerKey),
    );
    const knownKeysList = [...knownKeys].sort().join(', ') || '(none)';
    const reconcilableEntries = allDockerEntries.filter((entry) => {
      const refs = entry.providers ?? ['cf'];
      const unknown = refs.filter((r) => r !== 'all' && !knownKeys.has(r));
      if (unknown.length === 0) return true;
      this.loggerService.error(
        `AppService: entry ${entry.Key} (${entry.type} ${entry.name}) references unknown provider(s) [${unknown.join(', ')}]; configured providers: [${knownKeysList}]. Entry skipped.`,
      );
      return false;
    });

    // eslint-disable-next-line no-restricted-syntax
    for (const provider of this.providerRegistry.getAll()) {
      // Prepare (e.g., CF fetches zone list)
      // eslint-disable-next-line no-await-in-loop
      if (provider.prepareForJob) await provider.prepareForJob();

      // Filter entries targeting this provider
      const targeted = reconcilableEntries.filter(
        (e) =>
          (e.providers ?? ['cf']).includes(provider.providerKey) ||
          (e.providers ?? ['cf']).includes('all'),
      );

      // Per-provider deduplication
      const deduplicated = this.dedupeForProvider(
        targeted,
        provider.providerKey,
      );

      // Fetch current state from provider
      // eslint-disable-next-line no-await-in-loop
      const providerRecords = await provider.getRecords();

      // Compute diff
      const diff = computeSetDifference(deduplicated, providerRecords);

      // Apply diff
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([
        ...diff.add.map((e) => provider.createEntry(e)),
        ...diff.update.map(({ old, update }) =>
          provider.updateEntry(old, update),
        ),
        ...diff.delete.map((e) => provider.deleteEntry(e)),
      ]);

      const totalChanges =
        diff.add.length + diff.update.length + diff.delete.length;
      if (totalChanges > 0) {
        this.loggerService.log(
          `[${provider.providerKey}] Synchronisation complete: Added ${diff.add.length}, Updated ${diff.update.length}, Deleted ${diff.delete.length}, Unchanged ${diff.unchanged.length}`,
        );
      } else {
        this.loggerService.debug(
          `[${provider.providerKey}] Synchronisation complete: no changes, Unchanged ${diff.unchanged.length}`,
        );
      }
    }
  }

  private dedupeForProvider(
    entries: DnsbaseEntry[],
    providerKey: string,
  ): DnsbaseEntry[] {
    const seen = new Map<string, DnsbaseEntry>();
    const dupes = new Map<string, DnsbaseEntry[]>();

    // eslint-disable-next-line no-restricted-syntax
    for (const entry of entries) {
      const key = `${providerKey}:${entry.type}:${entry.name}`;
      if (dupes.has(key)) {
        dupes.get(key)!.push(entry);
      } else if (seen.has(key)) {
        dupes.set(key, [seen.get(key)!, entry]);
        seen.delete(key);
      } else {
        seen.set(key, entry);
      }
    }

    dupes.forEach((_dupEntries, key) => {
      this.loggerService.warn(
        `AppService, deduplication: entries share duplicate key '${key}' for provider '${providerKey}', all will be ignored`,
      );
    });

    return [...seen.values()];
  }
}
