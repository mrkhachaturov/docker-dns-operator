import { Injectable, LoggerService, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isNumber } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ProviderRegistry } from './providers/provider-registry.service';
import { ProviderSelector } from './providers/provider-selector';
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
   *
   * Two-phase: (1) sync init of registry + Docker service, then (2) the
   * async negotiate pass that fetches each sidecar's DomainFilter. The
   * negotiation runs at boot only — upstream external-dns caches it
   * per-process for the same reason, so a zone change on a sidecar
   * requires an operator restart. Negotiation failure is non-fatal:
   * each provider falls back to match-all and reconciliation proceeds.
   */
  async initialize(): Promise<void> {
    if (this.state === State.Initialized)
      throw Error(
        'AppService, initialize: Already initialized, but attempted to initialize again',
      );

    this.providerRegistry.initialize();
    this.dockerService.initialize();
    await this.providerRegistry.negotiateAll();
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
    let allDockerEntries = this.dockerService.extractDNSEntries(containers);

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
      this.ddnsService.stop();

    // Strict per-entry routing. Each entry's `providers` + `tags` fields are
    // resolved to a concrete set of provider keys by a ProviderSelector built
    // once for this pass (see src/providers/provider-selector.ts). An entry
    // that references any unknown provider key OR any tag matching no provider
    // is rejected loudly with a per-entry ERROR and skipped for the rest of
    // this cycle — including a tag that resolves to nothing, so "matched no
    // provider" is never a silent no-op. Other entries reconcile as normal.
    // We never fall back or guess what a typo meant. The resolved key set is
    // cached here so the per-provider loop below is a plain membership test.
    const registered = this.providerRegistry
      .getAll()
      .map((p) => ({ providerKey: p.providerKey, tags: p.tags ?? [] }));
    const selector = new ProviderSelector(registered);
    const knownKeysList =
      registered
        .map((p) => p.providerKey)
        .sort()
        .join(', ') || '(none)';
    const targetsByEntry = new Map<DnsbaseEntry, Set<string>>();
    const reconcilableEntries = allDockerEntries.filter((entry) => {
      const { keys, unknownProviders, unknownTags } = selector.resolve(
        entry.providers,
        entry.tags,
      );
      if (unknownProviders.length === 0 && unknownTags.length === 0) {
        targetsByEntry.set(entry, keys);
        return true;
      }
      const unknownParts = [
        unknownProviders.length > 0
          ? `provider(s) [${unknownProviders.join(', ')}]`
          : '',
        unknownTags.length > 0 ? `tag(s) [${unknownTags.join(', ')}]` : '',
      ]
        .filter(Boolean)
        .join(' and ');
      this.loggerService.error(
        `AppService: entry ${entry.Key} (${entry.type} ${entry.name}) references unknown ${unknownParts}; configured providers: [${knownKeysList}]. Entry skipped.`,
      );
      return false;
    });

    // eslint-disable-next-line no-restricted-syntax
    for (const provider of this.providerRegistry.getAll()) {
      // Prepare (e.g., CF fetches zone list)
      // eslint-disable-next-line no-await-in-loop
      if (provider.prepareForJob) await provider.prepareForJob();

      // Filter entries targeting this provider — a plain membership test
      // against the key set the selector resolved above (providers ∪ tags,
      // with 'all' and the backward-compat 'cf' default already expanded).
      const targeted = reconcilableEntries.filter((e) =>
        targetsByEntry.get(e)?.has(provider.providerKey),
      );

      // Domain pre-routing: drop entries whose name falls outside this
      // provider's zone scope (from the sidecar's DomainFilter). Without
      // this step the sidecar would silently refuse the record and the
      // failure would only surface in the sidecar's own log — see
      // src/webhook-provider/domain-filter.ts and the negotiate() hook.
      // Providers without matchesDomain (e.g. legacy non-webhook impls)
      // fall through unchanged.
      const inZone = provider.matchesDomain
        ? targeted.filter((e) => {
            if (provider.matchesDomain!(e.name)) return true;
            this.loggerService.warn(
              `AppService: entry ${e.Key} (${e.type} ${e.name}) routed to provider '${provider.providerKey}' which does not serve that zone — entry skipped for this provider.`,
            );
            return false;
          })
        : targeted;

      // Per-provider deduplication
      const deduplicated = this.dedupeForProvider(inZone, provider.providerKey);

      // Fetch current state from provider
      // eslint-disable-next-line no-await-in-loop
      const providerRecords = await provider.getRecords();

      // Compute diff
      const diff = computeSetDifference(deduplicated, providerRecords);

      // Apply diff. Per-entry isolation: one bad record (e.g. sidecar
      // refuses with "not in zone", auth flap, transient 5xx) must not
      // abort the rest of the cycle — Promise.all would, allSettled
      // lets every operation report independently. Failures are logged
      // by entry key + operation + reason so the operator log alone
      // tells the user which record was rejected and why, without
      // having to read the sidecar's own logs.
      const ops: Array<{
        kind: 'create' | 'update' | 'delete';
        key: string;
        promise: Promise<void>;
      }> = [
        ...diff.add.map((e) => ({
          kind: 'create' as const,
          key: e.Key,
          promise: provider.createEntry(e),
        })),
        ...diff.update.map(({ old, update }) => ({
          kind: 'update' as const,
          key: update.Key,
          promise: provider.updateEntry(old, update),
        })),
        ...diff.delete.map((r) => ({
          kind: 'delete' as const,
          key: r.Key,
          promise: provider.deleteEntry(r),
        })),
      ];

      // Narrate each intended change before applying, external-dns style
      // ("Desired change: CREATE A:app.example.com"). At the default `log`
      // level this is what the user sees when a labelled container is
      // deployed; quieter levels hide it, debug/verbose keep it.
      ops.forEach((op) => {
        this.loggerService.log(
          `[${provider.providerKey}] Desired change: ${op.kind.toUpperCase()} ${op.key}`,
        );
      });

      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled(ops.map((o) => o.promise));
      let failureCount = 0;
      results.forEach((r, i) => {
        if (r.status !== 'rejected') return;
        failureCount += 1;
        const op = ops[i];
        const reason =
          r.reason instanceof Error ? r.reason.message : String(r.reason);
        this.loggerService.warn(
          `[${provider.providerKey}] ${op.kind} ${op.key} failed: ${reason}`,
        );
      });

      const totalChanges =
        diff.add.length + diff.update.length + diff.delete.length;
      if (totalChanges > 0 || failureCount > 0) {
        this.loggerService.log(
          `[${provider.providerKey}] Synchronisation complete: Added ${diff.add.length}, Updated ${diff.update.length}, Deleted ${diff.delete.length}, Unchanged ${diff.unchanged.length}, Failed ${failureCount}`,
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
