import { DnsbaseEntry } from '../dto/dnsbase-entry';
import { IProviderRecord } from './provider-record.interface';

/**
 * Contract for all DNS provider implementations.
 * A provider is activated only when isConfigured() returns true.
 */
export interface IDnsProvider {
  /** Short identifier used in label routing. Values: 'cf', 'mikrotik' */
  readonly providerKey: string;

  /** Returns true if all required env vars for this provider are set. */
  isConfigured(): boolean;

  /** Called once per provider when it is registered. Must throw if misconfigured. */
  initialize(): void;

  /**
   * Called once per sync job before getRecords/createEntry etc.
   * Use for per-job setup such as fetching and caching zones.
   * Optional: only called if implemented.
   */
  prepareForJob?(): Promise<void>;

  /** Returns all DNS records currently managed by this instance (filtered by ownership tag). */
  getRecords(): Promise<IProviderRecord[]>;

  /** Creates a new DNS record for the given entry. */
  createEntry(entry: DnsbaseEntry): Promise<void>;

  /**
   * Updates an existing record. oldRecord carries providerContext (e.g. zoneId)
   * so the provider does not need to re-fetch it.
   */
  updateEntry(oldRecord: IProviderRecord, desired: DnsbaseEntry): Promise<void>;

  /** Deletes an existing record. oldRecord carries providerContext. */
  deleteEntry(oldRecord: IProviderRecord): Promise<void>;
}
