import { IsIP } from 'class-validator';
import { DnsbaseEntry, DNSTypes, IHasDnsType } from './dnsbase-entry';

export class DnsAaaaEntry extends DnsbaseEntry {
  type = DNSTypes.AAAA;

  @IsIP(6)
  address: string;

  hasSameValue(otherEntry: DnsAaaaEntry): boolean {
    return this.address.toLowerCase() === otherEntry.address.toLowerCase();
  }
}

export function isDnsAaaaEntry(entry: IHasDnsType): entry is DnsAaaaEntry {
  return entry.type === DNSTypes.AAAA;
}
