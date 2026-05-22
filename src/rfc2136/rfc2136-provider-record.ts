import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsAaaaEntry } from '../dto/dnsaaaa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry } from '../dto/dnsns-entry';
import { IProviderRecord } from '../providers/provider-record.interface';
import { Rfc2136Record } from './types';

const stripDot = (s: string): string => (s.endsWith('.') ? s.slice(0, -1) : s);

export interface Rfc2136RecordTtlOptions {
  defaultTtl: number;
  minTtl: number;
}

export class Rfc2136ProviderRecord implements IProviderRecord {
  readonly id: string;

  readonly name: string;

  readonly type: DNSTypes;

  readonly Key: string;

  readonly providerContext: Record<string, unknown>;

  constructor(
    private readonly raw: Rfc2136Record,
    zone: string,
    private readonly ttlOpts: Rfc2136RecordTtlOptions,
  ) {
    this.id = `${raw.type}:${raw.name}`;
    this.name = raw.name;
    this.type = raw.type as DNSTypes;
    this.Key = `${raw.type}:${raw.name}`;
    this.providerContext = { zone, raw };
  }

  hasSameValue(desired: DnsbaseEntry): boolean {
    if (!this.valueMatches(desired)) return false;
    return this.ttlMatches(desired);
  }

  private valueMatches(desired: DnsbaseEntry): boolean {
    if (desired instanceof DnsaEntry && this.raw.type === 'A') {
      return this.raw.value === desired.address;
    }
    if (desired instanceof DnsAaaaEntry && this.raw.type === 'AAAA') {
      return this.raw.value.toLowerCase() === desired.address.toLowerCase();
    }
    if (desired instanceof DnsCnameEntry && this.raw.type === 'CNAME') {
      return (
        stripDot(this.raw.value.toLowerCase()) ===
        stripDot(desired.target.toLowerCase())
      );
    }
    if (desired instanceof DnsMxEntry && this.raw.type === 'MX') {
      const [pri, ...rest] = this.raw.value.split(/\s+/);
      const tgt = rest.join(' ');
      return (
        Number.parseInt(pri, 10) === desired.priority &&
        stripDot(tgt.toLowerCase()) === stripDot(desired.server.toLowerCase())
      );
    }
    if (desired instanceof DnsNsEntry && this.raw.type === 'NS') {
      return (
        stripDot(this.raw.value.toLowerCase()) ===
        stripDot(desired.server.toLowerCase())
      );
    }
    return false;
  }

  private ttlMatches(desired: DnsbaseEntry): boolean {
    const explicitTtl = desired.providerOptions?.rfc2136?.ttl;
    const effectiveDesired = Math.max(
      explicitTtl ?? this.ttlOpts.defaultTtl,
      this.ttlOpts.minTtl,
    );
    const effectiveRaw = Math.max(this.raw.ttl, this.ttlOpts.minTtl);
    return effectiveDesired === effectiveRaw;
  }
}
