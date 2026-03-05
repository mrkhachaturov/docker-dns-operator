import { IProviderRecord } from '../providers/provider-record.interface';
import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { isDnsAEntry } from '../dto/dnsa-entry';
import { isDnsCnameEntry } from '../dto/dnscname-entry';
import { isDnsMxEntry } from '../dto/dnsmx-entry';
import { isDnsNsEntry } from '../dto/dnsns-entry';

/**
 * Represents a DNS record as returned by the CloudFlare API.
 * Implements IProviderRecord so it can be used in the generic set-diff.
 */
export class CloudflareProviderRecord implements IProviderRecord {
  id: string;

  name: string;

  type: DNSTypes;

  zoneId: string;

  // Type-specific data
  address?: string; // A

  target?: string; // CNAME

  server?: string; // MX, NS

  priority?: number; // MX

  proxy?: boolean; // A, CNAME

  get Key(): string {
    return `${this.type}:${this.name}`;
  }

  get providerContext(): Record<string, unknown> {
    return { zoneId: this.zoneId };
  }

  /**
   * Compares CloudFlare record values against a desired docker entry.
   * Includes proxy comparison (CF-specific).
   */
  hasSameValue(desiredEntry: DnsbaseEntry): boolean {
    const desiredProxy = desiredEntry.providerOptions?.cf?.proxy ?? false;

    if (isDnsAEntry(desiredEntry)) {
      return (
        this.address === desiredEntry.address &&
        (this.proxy ?? false) === desiredProxy
      );
    }
    if (isDnsCnameEntry(desiredEntry)) {
      return (
        this.target === desiredEntry.target &&
        (this.proxy ?? false) === desiredProxy
      );
    }
    if (isDnsMxEntry(desiredEntry)) {
      return (
        this.server === desiredEntry.server &&
        this.priority === desiredEntry.priority
      );
    }
    if (isDnsNsEntry(desiredEntry)) {
      return this.server === desiredEntry.server;
    }
    return false;
  }
}
