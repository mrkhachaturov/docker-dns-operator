import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Cloudflare from 'cloudflare';
import { Zone } from 'cloudflare/resources/zones/zones';
import {
  ARecord,
  CNAMERecord,
  MXRecord,
  NSRecord,
  Record,
  RecordCreateParams,
  RecordUpdateParams,
} from 'cloudflare/resources/dns/records';
import { ConsoleLoggerService } from '../logger.service';
import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { IProviderRecord } from '../providers/provider-record.interface';
import { IDnsProvider } from '../providers/dns-provider.interface';
import { CloudflareProviderRecord } from './cloudflare-provider-record';
import { CloudFlareFactory } from './cloud-flare.factory';
import { NestedError } from '../errors/nested-error';
import { getLogClassDecorator } from '../utility.functions';

let loggerPointer: ConsoleLoggerService;
const LogDecorator = getLogClassDecorator(() => loggerPointer);

/**
 * Possible states of the CloudFlare service
 */
export enum State {
  Uninitialized,
  Initialized,
}

/**
 * Behaviors associated with CloudFlare.
 * For example, creating, updating and deleting DNS records.
 */
@LogDecorator()
@Injectable()
export class CloudFlareService implements IDnsProvider {
  readonly providerKey = 'cf';

  private state: State = State.Uninitialized;

  private cloudFlare: Cloudflare;

  private cachedZones: Zone[] | null = null;

  constructor(
    private cloudFlareFactory: CloudFlareFactory,
    private configService: ConfigService,
    private loggerService: ConsoleLoggerService,
  ) {
    loggerPointer = this.loggerService;
  }

  /**
   * Returns true if the CloudFlare API token is configured in the environment.
   */
  isConfigured(): boolean {
    return !!(process.env.API_TOKEN || process.env.API_TOKEN_FILE);
  }

  /**
   * Initializes the service.
   * Required before calling any public methods that interact with CloudFlare directly.
   *
   * Configures CloudFlare.
   * @throws {Error} if already initialized when called.
   */
  initialize() {
    if (this.state === State.Initialized)
      throw Error(
        'CloudFlareService, initialize: Already initialized, but attempted to initialize again',
      );

    this.cloudFlare = new Cloudflare({
      apiToken: this.configService.get<string>('API_TOKEN', { infer: true }),
    });

    this.state = State.Initialized;
  }

  /**
   * Fetches and caches zones for use during the current sync job.
   * @throws {Error} if no zones are returned from CloudFlare.
   */
  async prepareForJob(): Promise<void> {
    this.cachedZones = await this.getZones();
    if (this.cachedZones.length === 0) {
      throw new Error(
        'CloudFlareService, prepareForJob: No zones returned from CloudFlare. Check API Token has Zone access.',
      );
    }
  }

  /**
   * Returns all DNS records managed by this CloudFlare instance.
   * @throws {Error} if prepareForJob() has not been called.
   */
  async getRecords(): Promise<CloudflareProviderRecord[]> {
    if (!this.cachedZones)
      throw new Error('CloudFlareService: call prepareForJob() first');
    const allRecords: CloudflareProviderRecord[] = [];
    for (const zone of this.cachedZones) {
      // eslint-disable-next-line no-await-in-loop
      const raw = await this.getDNSEntries(zone.id);
      allRecords.push(...this.mapDNSEntries(zone.id, raw));
    }
    return allRecords;
  }

  /**
   * Fetches from CloudFlare all the zones that can be read
   * @returns {Promise<Zone[]>} Promise which resolves to all the accessible CloudFlare Zones
   */
  @LogDecorator({ level: 'debug' })
  async getZones(): Promise<Zone[]> {
    if (this.state === State.Uninitialized)
      throw Error(
        'CloudFlareService, getZones: Not initialized, call initialize first',
      );

    try {
      let result: Zone[] = [];
      let paginatedResult = await this.cloudFlare.zones.list();
      result = [...result, ...paginatedResult.getPaginatedItems()];
      while (paginatedResult.hasNextPage()) {
        /* This rule is intentionally disabled:
         *
         * It's a performance based rule which says you should dispatch all async
         * calls at once rather than awaiting within a loop which causes them to run
         * sequentially.
         *
         * In our case as the async is exposed via method calls it's not possible
         * to execute them all and wait using Promise.all.
         *
         * Recursion would solve this but not improve performance and make testing
         * harder.
         *
         * Hence disabling the rule.
         */
        // eslint-disable-next-line no-await-in-loop
        paginatedResult = await paginatedResult.getNextPage();
        result = [...result, ...paginatedResult.getPaginatedItems()];
      }
      return result;
    } catch (error) {
      throw new NestedError(
        'CloudFlareService, getZones: Error fetching Zones from CloudFlare',
        error,
      );
    }
  }

  /**
   * Given an array of CloudFlare Zones and a business object representing a DNS Entry.
   * Determines which zone if any the entry belongs to.
   *
   * It does this by comparing the domain name suffix in the name of the entry to the zones.
   *
   * Will warn if no match is found.
   *
   * @param zones List of zones to determine if the entry belong to
   * @param entry The entry to find the zone for
   * @returns An object determining if the operation was successful. If it was, it also includes the result.
   */
  getZoneForEntry(
    zones: Zone[],
    entry: DnsbaseEntry,
  ): { isSuccessful: boolean; zone?: Zone } {
    const result = zones.find(({ name }) => entry.name.endsWith(name));
    if (result === undefined) {
      this.loggerService.warn(
        `CloudFlareService, getZoneForEntry: No zone found for entry. (name: "${entry.name}", zones: "${JSON.stringify(zones.map((zone) => zone.name))}")`,
      );
      return { isSuccessful: false };
    }
    return { isSuccessful: true, zone: result };
  }

  /**
   * For the given zone, fetches the DNS entries from CloudFlare
   * @param zoneId Zone to fetch entries for
   * @returns A promise which resolves to the records in the zone
   * @throws {Error} If service isn't initialized.
   * @throws {NestedError} If CloudFlare errors fetching DNS records.
   */
  @LogDecorator({ level: 'debug' })
  async getDNSEntries(zoneId: string): Promise<Cloudflare.DNS.Record[]> {
    if (this.state === State.Uninitialized)
      throw Error(
        'CloudFlareService, getDNSEntries: Not initialized, call initialize first',
      );

    try {
      let result: Record[] = [];
      let paginatedResult = await this.cloudFlare.dns.records.list({
        zone_id: zoneId,
        comment: {
          exact: this.configService.get<string>('ENTRY_IDENTIFIER', {
            infer: true,
          }),
        },
      });
      result = [...result, ...paginatedResult.getPaginatedItems()];
      while (paginatedResult.hasNextPage()) {
        /* This rule is intentionally disabled:
         *
         * It's a performance based rule which says you should dispatch all async
         * calls at once rather than awaiting within a loop which causes them to run
         * sequentially.
         *
         * In our case as the async is exposed via method calls it's not possible
         * to execute them all and wait using Promise.all.
         *
         * Recursion would solve this but not improve performance and make testing
         * harder.
         *
         * Hence disabling the rule.
         */
        // eslint-disable-next-line no-await-in-loop
        paginatedResult = await paginatedResult.getNextPage();
        result = [...result, ...paginatedResult.getPaginatedItems()];
      }
      return result;
    } catch (error) {
      throw new NestedError(
        'CloudFlareService, getDNSEntries: Error fetching DNS records from CloudFlare',
        error,
      );
    }
  }

  /**
   * Maps the CloudFlare DNS Records to CloudflareProviderRecord instances.
   * @param {string} zoneId ID of the CloudFlare Zone these records were loaded from
   * @param {Cloudflare.DNS.Record[]} entries DNS entries from CloudFlare
   * @returns {CloudflareProviderRecord[]} Entries transformed into CloudflareProviderRecord instances
   */
  mapDNSEntries(
    zoneId: string,
    entries: Cloudflare.DNS.Record[],
  ): CloudflareProviderRecord[] {
    return entries.map((cloudFlareEntry) => {
      const record = new CloudflareProviderRecord();
      record.id = cloudFlareEntry.id as string;
      record.name = cloudFlareEntry.name;
      record.zoneId = zoneId;

      switch (cloudFlareEntry.type) {
        case 'A': {
          const { content, proxied } = cloudFlareEntry as ARecord;
          record.address = content;
          record.proxy = proxied as boolean;
          record.type = DNSTypes.A;
          break;
        }
        case 'CNAME': {
          const { content, proxied } = cloudFlareEntry as CNAMERecord;
          record.target = content as string;
          record.proxy = proxied as boolean;
          record.type = DNSTypes.CNAME;
          break;
        }
        case 'MX': {
          const { content, priority } = cloudFlareEntry as MXRecord;
          record.server = content;
          record.priority = priority;
          record.type = DNSTypes.MX;
          break;
        }
        case 'NS': {
          const { content } = cloudFlareEntry as NSRecord;
          record.server = content;
          record.type = DNSTypes.NS;
          break;
        }
        default: {
          record.type = DNSTypes.Unsupported;
          this.loggerService
            .warn(`CloudFlareService, mapDNSEntries: Unsupported entry with id ${cloudFlareEntry.id} found.
            It will be DELETED. Do not add the tracking comment to other DNS entries in CloudFlare!`);
        }
      }

      return record;
    });
  }

  /**
   * Creates a DNS entry in CloudFlare for the given DnsbaseEntry.
   * Resolves the zone from cached zones. Logs and skips if no zone found.
   */
  @LogDecorator({ level: 'debug' })
  async createEntry(entry: DnsbaseEntry): Promise<void> {
    const zoneResult = this.getZoneForEntry(this.cachedZones!, entry);
    if (!zoneResult.isSuccessful || !zoneResult.zone) {
      this.loggerService.warn(
        `CloudFlareService, createEntry: no zone found for ${entry.name}, skipping`,
      );
      return;
    }
    const params = this.cloudFlareFactory.createOrUpdateParams(
      zoneResult.zone.id,
      entry,
    );
    try {
      await this.cloudFlare.dns.records.create(params);
    } catch (error) {
      throw new NestedError(
        `CloudFlareService, createEntry: Cloudflare errored creating entry. (${JSON.stringify(entry)})`,
        error,
      );
    }
  }

  /**
   * Updates an existing DNS record in CloudFlare.
   * Uses providerContext.zoneId from the old record.
   */
  @LogDecorator({ level: 'debug' })
  async updateEntry(
    oldRecord: IProviderRecord,
    desired: DnsbaseEntry,
  ): Promise<void> {
    const { zoneId } = oldRecord.providerContext as { zoneId: string };
    const params = this.cloudFlareFactory.createOrUpdateParams(zoneId, desired);
    try {
      await this.cloudFlare.dns.records.update(oldRecord.id, params);
    } catch (error) {
      throw new NestedError(
        `CloudFlareService, createEntry: Cloudflare errored updating entry. (${JSON.stringify(desired)})`,
        error,
      );
    }
  }

  /**
   * Deletes a DNS record in CloudFlare.
   * Uses providerContext.zoneId from the old record.
   */
  @LogDecorator({ level: 'debug' })
  async deleteEntry(oldRecord: IProviderRecord): Promise<void> {
    const { zoneId } = oldRecord.providerContext as { zoneId: string };
    try {
      await this.cloudFlare.dns.records.delete(oldRecord.id, {
        zone_id: zoneId,
      });
    } catch (error) {
      throw new NestedError(
        `CloudFlareService, createEntry: Cloudflare errored deleting entry. (zone_id: ${zoneId}, dnsRecordId: ${oldRecord.id})`,
        error,
      );
    }
  }
}
