import { IProviderRecord } from '../providers/provider-record.interface';
import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { isDnsAEntry } from '../dto/dnsa-entry';
import { isDnsCnameEntry } from '../dto/dnscname-entry';
import { isDnsMxEntry } from '../dto/dnsmx-entry';
import { isDnsNsEntry } from '../dto/dnsns-entry';

export class MikrotikProviderRecord implements IProviderRecord {
  id: string; // MikroTik .id field

  name: string;

  type: DNSTypes;

  ttl?: string; // MikroTik duration string

  comment?: string;

  // Type-specific
  address?: string; // A

  cname?: string; // CNAME

  server?: string; // MX exchange / NS

  priority?: number; // MX preference

  text?: string; // TXT (future)

  get Key(): string {
    return `${this.type}:${this.name}`;
  }

  // eslint-disable-next-line class-methods-use-this
  get providerContext(): Record<string, unknown> {
    return {}; // MikroTik has no zones — context is empty
  }

  hasSameValue(desiredEntry: DnsbaseEntry): boolean {
    if (isDnsAEntry(desiredEntry)) return this.address === desiredEntry.address;
    if (isDnsCnameEntry(desiredEntry))
      return this.cname === desiredEntry.target;
    if (isDnsMxEntry(desiredEntry)) {
      return (
        this.server === desiredEntry.server &&
        this.priority === desiredEntry.priority
      );
    }
    if (isDnsNsEntry(desiredEntry)) return this.server === desiredEntry.server;
    return false;
  }
}
