import { DnsbaseEntry } from '../dto/dnsbase-entry';
import { IProviderRecord } from './provider-record.interface';

/**
 * Contract for all DNS provider implementations.
 * A provider is activated only when isConfigured() returns true.
 */
export interface IDnsProvider {
  /**
   * Short identifier used in label routing. 'cf' for the in-process
   * CloudFlare provider; otherwise the lower-cased <NAME> from
   * WEBHOOK_<NAME>_URL (e.g. 'mikrotik', 'rfc2136').
   */
  readonly providerKey: string;

  /**
   * Routing tags declared for this provider (via WEBHOOK_<NAME>_TAGS). A
   * `tags: [...]` label entry targets every provider carrying one of these.
   * Optional: providers with no tags omit it — the selector treats absence
   * as an empty tag set.
   */
  readonly tags?: string[];

  /** Returns true if all required env vars for this provider are set. */
  isConfigured(): boolean;

  /** Called once per provider when it is registered. Must throw if misconfigured. */
  initialize(): void;

  /**
   * Called once at startup, after initialize(), to discover provider-side
   * constraints — primarily the DomainFilter (which zones the provider
   * actually serves) per the external-dns webhook v1 negotiation
   * contract. Result is cached for the operator's lifetime; a zone change
   * on the sidecar needs an operator restart.
   *
   * Optional: providers that don't expose a negotiation endpoint can
   * omit this. Implementations must NOT throw on transient negotiation
   * failure — log + fail-open (matchesDomain returns true) so a single
   * misbehaving sidecar doesn't stop the operator from booting.
   */
  negotiate?(): Promise<void>;

  /**
   * Returns true if the given record name falls inside this provider's
   * zone scope (computed from the negotiated DomainFilter). Used by the
   * reconciler to pre-filter records before any apply attempt, so a
   * record going to the wrong sidecar is dropped at the operator layer
   * with a single named WARN instead of a per-cycle sidecar 4xx.
   *
   * Optional: providers without a notion of "domain filter" can omit
   * this — the reconciler treats absence as match-all.
   */
  matchesDomain?(name: string): boolean;

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
