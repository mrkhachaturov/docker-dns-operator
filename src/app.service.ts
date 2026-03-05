import { Injectable, LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isNumber } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CloudFlareService } from './cloud-flare/cloud-flare.service';
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
 * the docker labels and CloudFlare.
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
    private cloudFlareService: CloudFlareService,
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
   * Initializes CloudFlare and Docker services
   */
  initialize() {
    this.cloudFlareService.initialize();
    this.dockerService.initialize();
    this.state = State.Initialized;
  }

  /**
   * Fetches labels from docker.
   * Fetches records from CloudFlare.
   * Computes additions, updates, deletions and unchanged.
   * Adds, Updates and Deletes entries from CloudFlare.
   */
  @LogDecorator({ level: 'debug' })
  async job() {
    if (this.state === State.Uninitialized)
      throw new Error(
        'AppService, synchronize: Not initialized, cannot synchronize. Call initialize first',
      );

    // Prepare CloudFlare: fetch and cache zones
    await this.cloudFlareService.prepareForJob!();

    // Fetch all current CloudFlare records
    const cloudFlareEntries = await this.cloudFlareService.getRecords!();

    // Get docker containers and extract DNS entries
    const containers = await this.dockerService.getContainers();
    let dockerEntries = await this.dockerService.extractDNSEntries(containers);

    // Determine if DDNS is required
    if (this.ddnsService.isDdnsRequired(dockerEntries)) {
      if (this.ddnsService.getState() === CronState.Stopped)
        await this.ddnsService.start();
      const address = this.ddnsService.getIPAddress();
      if (address === undefined) {
        this.loggerService
          .warn(`DDNS, IPAddress has yet to be fetched successfully. DDNS records have been filtered out.
          They'll be added in automatically once an IPAddress has been fetched.`);
        dockerEntries = dockerEntries.filter(
          (entry) => !(isDnsAEntry(entry) && entry.address === 'DDNS'),
        );
      } else {
        dockerEntries = dockerEntries.map((entry) => {
          if (!isDnsAEntry(entry)) return entry;
          if (entry.address !== 'DDNS') return entry;
          return plainToInstance(DnsaEntry, { ...entry, address });
        });
      }
    } else if (this.ddnsService.getState() === CronState.Started)
      await this.ddnsService.stop();

    // Compute set differences
    const setDifference = computeSetDifference(dockerEntries, cloudFlareEntries);

    // Apply changes
    const requests = [
      ...setDifference.add.map((entry) =>
        this.cloudFlareService.createEntry(entry),
      ),
      ...setDifference.update.map(({ old, update }) =>
        this.cloudFlareService.updateEntry(old, update),
      ),
      ...setDifference.delete.map((entry) =>
        this.cloudFlareService.deleteEntry(entry),
      ),
    ];
    await Promise.all(requests);

    this.loggerService.log(
      `Synchronisation complete, entries changed: Added ${setDifference.add.length}, Updated ${setDifference.update.length}, Deleted ${setDifference.delete.length}, Unchanged ${setDifference.unchanged.length}`,
    );
  }
}
