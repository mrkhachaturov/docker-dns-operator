import { DNSTypes } from '../dto/dnsbase-entry';
import { DnsbaseEntry } from '../dto/dnsbase-entry';

/**
 * A DNS record as read from a provider's current state.
 * Carries enough context for the provider to perform update/delete without extra lookups.
 */
export interface IProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly type: DNSTypes;
  /** Composite key for set-diff matching: `${type}:${name}` */
  readonly Key: string;
  /**
   * Compares provider-specific record values against a desired docker entry.
   * Returns true if no update is needed.
   */
  hasSameValue(desiredEntry: DnsbaseEntry): boolean;
  /**
   * Provider-specific opaque context needed for update/delete operations.
   * Example: { zoneId: 'zone-abc' } for CloudFlare; {} for MikroTik.
   */
  readonly providerContext: Record<string, unknown>;
}
