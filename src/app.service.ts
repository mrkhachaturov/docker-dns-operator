import { Injectable, LoggerService } from '@nestjs/common';
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
import { CronService, State as CronState } from './cron/cron.service';
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
 * Behaviors to initialize the applications services and execute the synchronization between
 * the docker labels and all configured DNS providers.
 */
@LogDecorator()
@Injectable()
export class AppService extends CronService {
  private state = State.Uninitialized;

  /**
   * ServiceName used in logging present in CronService
   */
  // eslint-disable-next-line class-methods-use-this
  get ServiceName(): string {
    return AppService.name;
  }

  /**
   * Fetches the EXECUTION_FREQUENCY_SECONDS
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

  constructor(
    private providerRegistry: ProviderRegistry,
    private dockerService: DockerService,
    private configService: ConfigService,
    private ddnsService: DdnsService,
    loggerService: ConsoleLoggerService,
  ) {
    super(loggerService);
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
