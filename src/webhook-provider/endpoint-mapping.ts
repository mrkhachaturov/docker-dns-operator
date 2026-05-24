import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { DnsaEntry, isDnsAEntry } from '../dto/dnsa-entry';
import { DnsAaaaEntry, isDnsAaaaEntry } from '../dto/dnsaaaa-entry';
import { DnsCnameEntry, isDnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry, isDnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry, isDnsNsEntry } from '../dto/dnsns-entry';
import { Endpoint, ProviderSpecificProperty } from './types';

/**
 * Label key on Endpoint used to tag records with the operator instance
 * that owns them. Matches the external-dns convention (OwnerLabelKey).
 */
export const OWNER_LABEL_KEY = 'owner';

/**
 * Provider-specific property name used to round-trip the Cloudflare
 * orange-cloud proxy toggle. Matches the upstream external-dns Cloudflare
 * provider convention so the wire format stays interoperable.
 */
export const CLOUDFLARE_PROXIED_KEY =
  'external-dns.alpha.kubernetes.io/cloudflare-proxied';

function cfProxiedSpecificFromEntry(
  entry: DnsbaseEntry,
): ProviderSpecificProperty | undefined {
  if (!isDnsAEntry(entry) && !isDnsCnameEntry(entry)) return undefined;
  const proxy = entry.providerOptions?.cf?.proxy;
  if (proxy === undefined) return undefined;
  return {
    name: CLOUDFLARE_PROXIED_KEY,
    value: proxy ? 'true' : 'false',
  };
}

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
 *
 * Cloudflare's proxy toggle (`providerOptions.cf.proxy`) is emitted as a
 * providerSpecific entry on A/CNAME records so the ddo-cloudflare sidecar
 * can apply it. Other sidecars ignore providerSpecific properties they
 * don't recognise.
 */
export function dnsEntryToEndpoint(
  entry: DnsbaseEntry,
  ownershipLabel: string,
): Endpoint {
  const base = {
    dnsName: entry.name,
    labels: { [OWNER_LABEL_KEY]: ownershipLabel },
  };

  const cfProxiedSpecific = cfProxiedSpecificFromEntry(entry);

  if (isDnsAEntry(entry)) {
    return {
      ...base,
      recordType: 'A',
      targets: [(entry as DnsaEntry).address],
      ...(cfProxiedSpecific && { providerSpecific: [cfProxiedSpecific] }),
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
      ...(cfProxiedSpecific && { providerSpecific: [cfProxiedSpecific] }),
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

/**
 * Reads the cloudflare-proxied providerSpecific property from an Endpoint
 * and returns its boolean form. Returns `undefined` when absent or when
 * the value can't be parsed — callers treat undefined as "no opinion".
 */
export function cfProxiedFromEndpoint(ep: Endpoint): boolean | undefined {
  if (!ep.providerSpecific) return undefined;
  const entry = ep.providerSpecific.find(
    (p) => p.name === CLOUDFLARE_PROXIED_KEY,
  );
  if (!entry) return undefined;
  if (entry.value === 'true') return true;
  if (entry.value === 'false') return false;
  return undefined;
}
