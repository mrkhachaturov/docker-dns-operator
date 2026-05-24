import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { DnsaEntry, isDnsAEntry } from '../dto/dnsa-entry';
import { DnsAaaaEntry, isDnsAaaaEntry } from '../dto/dnsaaaa-entry';
import { DnsCnameEntry, isDnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry, isDnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry, isDnsNsEntry } from '../dto/dnsns-entry';
import { Endpoint } from './types';

/**
 * Label key on Endpoint used to tag records with the operator instance
 * that owns them. Matches the external-dns convention (OwnerLabelKey).
 */
export const OWNER_LABEL_KEY = 'owner';

/**
 * Convert a DnsbaseEntry (operator-side DTO) into an Endpoint (wire form).
 *
 * targets is always a list of one for these record types. For MX the
 * single target follows the canonical "<priority> <server>" form that
 * external-dns and most authoritative DNS APIs accept.
 *
 * The ownership label is always stamped onto labels[owner] so a sidecar
 * that round-trips labels can let the operator filter its own records
 * from getRecords output (see webhook-provider.ts).
 */
export function dnsEntryToEndpoint(
  entry: DnsbaseEntry,
  ownershipLabel: string,
): Endpoint {
  const base = {
    dnsName: entry.name,
    labels: { [OWNER_LABEL_KEY]: ownershipLabel },
  };

  if (isDnsAEntry(entry)) {
    return {
      ...base,
      recordType: 'A',
      targets: [(entry as DnsaEntry).address],
    };
  }
  if (isDnsAaaaEntry(entry)) {
    return {
      ...base,
      recordType: 'AAAA',
      targets: [(entry as DnsAaaaEntry).address],
    };
  }
  if (isDnsCnameEntry(entry)) {
    return {
      ...base,
      recordType: 'CNAME',
      targets: [(entry as DnsCnameEntry).target],
    };
  }
  if (isDnsMxEntry(entry)) {
    const mx = entry as DnsMxEntry;
    return {
      ...base,
      recordType: 'MX',
      targets: [`${mx.priority} ${mx.server}`],
    };
  }
  if (isDnsNsEntry(entry)) {
    return {
      ...base,
      recordType: 'NS',
      targets: [(entry as DnsNsEntry).server],
    };
  }
  throw new Error(
    `dnsEntryToEndpoint: unsupported DNS type '${entry.type}' on ${entry.name}`,
  );
}

/**
 * Maps the wire-side record type string back to our DNSTypes enum.
 * Anything not in the known set returns DNSTypes.Unsupported.
 */
export function wireTypeToDnsType(recordType: string): DNSTypes {
  switch (recordType) {
    case 'A':
      return DNSTypes.A;
    case 'AAAA':
      return DNSTypes.AAAA;
    case 'CNAME':
      return DNSTypes.CNAME;
    case 'MX':
      return DNSTypes.MX;
    case 'NS':
      return DNSTypes.NS;
    default:
      return DNSTypes.Unsupported;
  }
}
