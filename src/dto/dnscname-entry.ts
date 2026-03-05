import { IsFQDN } from 'class-validator';
import { DnsbaseEntry } from './dnsbase-entry';
import { DNSTypes, IHasDnsType } from './dnsbase-entry';

export class DnsCnameEntry extends DnsbaseEntry {
  @IsFQDN()
  target: string;

  hasSameValue(otherEntry: DnsCnameEntry): boolean {
    return this.target === otherEntry.target;
  }
}

export function isDnsCnameEntry(entry: IHasDnsType): entry is DnsCnameEntry {
  return entry.type === DNSTypes.CNAME;
}
