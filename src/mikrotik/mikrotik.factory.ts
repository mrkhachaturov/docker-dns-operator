import { Injectable } from '@nestjs/common';
import { DnsbaseEntry } from '../dto/dnsbase-entry';
import { isDnsAEntry } from '../dto/dnsa-entry';
import { isDnsCnameEntry } from '../dto/dnscname-entry';
import { isDnsMxEntry } from '../dto/dnsmx-entry';
import { isDnsNsEntry } from '../dto/dnsns-entry';
import { secondsToMikrotikTTL } from './mikrotik-ttl';

@Injectable()
export class MikrotikFactory {
  /**
   * Builds the JSON body for a MikroTik REST PUT (create) request.
   * Sets ownership comment and default TTL.
   */
  toCreateBody(
    entry: DnsbaseEntry,
    entryIdentifier: string,
    defaultTTLSeconds: number,
  ): Record<string, unknown> {
    return {
      ...this.toBaseBody(entry),
      comment: entryIdentifier,
      ttl: secondsToMikrotikTTL(defaultTTLSeconds),
    };
  }

  /**
   * Builds the JSON body for a MikroTik REST PATCH (update) request.
   * Does NOT include comment or TTL (those are left unchanged on the record).
   */
  toUpdateBody(entry: DnsbaseEntry): Record<string, unknown> {
    return this.toBaseBody(entry);
  }

  private toBaseBody(entry: DnsbaseEntry): Record<string, unknown> {
    const base: Record<string, unknown> = { name: entry.name, type: entry.type };
    if (isDnsAEntry(entry)) { return { ...base, address: entry.address }; }
    if (isDnsCnameEntry(entry)) { return { ...base, cname: entry.target }; }
    if (isDnsMxEntry(entry)) {
      return { ...base, 'mx-exchange': entry.server, 'mx-preference': String(entry.priority) };
    }
    if (isDnsNsEntry(entry)) { return { ...base, ns: entry.server }; }
    throw new Error(`MikrotikFactory: unsupported DNS type '${entry.type}'`);
  }
}
