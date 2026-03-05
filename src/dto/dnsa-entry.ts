import { Validate } from 'class-validator';
import { DnsbaseEntry, DNSTypes, IHasDnsType } from './dnsbase-entry';
import { IsIPOrDDNS } from '../validators/iporddns.validator';

export class DnsaEntry extends DnsbaseEntry {
  @Validate(IsIPOrDDNS)
  address: string;

  /**
   * Provider-neutral comparison — only checks address.
   * Proxy is NOT checked here. CloudflareProviderRecord.hasSameValue reads
   * desiredEntry.providerOptions.cf.proxy and compares it to its own proxy field.
   */
  hasSameValue(otherEntry: DnsaEntry): boolean {
    return this.address === otherEntry.address;
  }
}

export function isDnsAEntry(entry: IHasDnsType): entry is DnsaEntry {
  return entry.type === DNSTypes.A;
}
