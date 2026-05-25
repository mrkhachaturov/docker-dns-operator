import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { isDnsAEntry } from '../dto/dnsa-entry';
import { isDnsCnameEntry } from '../dto/dnscname-entry';
import { IProviderRecord } from '../providers/provider-record.interface';
import {
  cfProxiedFromEndpoint,
  dnsEntryToEndpoint,
  wireTypeToDnsType,
} from './endpoint-mapping';
import { Endpoint } from './types';

function targetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (xs: string[]) => [...xs].map((s) => s.toLowerCase()).sort();
  const aN = norm(a);
  const bN = norm(b);
  return aN.every((v, i) => v === bN[i]);
}

/**
 * IProviderRecord adapter over a wire-side Endpoint.
 *
 * The current cycle's full Endpoint is stashed in providerContext so
 * WebhookProvider can build the updateOld payload without re-fetching.
 *
 * hasSameValue re-uses dnsEntryToEndpoint to project the desired
 * DnsbaseEntry into the same wire shape and compares targets +
 * recordType. For A/CNAME records the Cloudflare proxy toggle is also
 * compared via the cloudflare-proxied providerSpecific property — when
 * the operator toggles `providerOptions.cf.proxy` the diff fires an
 * update even though the address/target hasn't changed. TTL is NOT
 * compared yet (the operator doesn't surface per-entry TTL via
 * DnsbaseEntry for webhook targets).
 *
 * Comparison is case-insensitive on hostnames (DNS is case-insensitive
 * by spec; backends sometimes lowercase, sometimes preserve).
 */
export class WebhookProviderRecord implements IProviderRecord {
  readonly id: string;

  readonly name: string;

  readonly type: DNSTypes;

  readonly Key: string;

  readonly providerContext: { endpoint: Endpoint };

  constructor(private readonly endpoint: Endpoint) {
    this.name = endpoint.dnsName;
    this.type = wireTypeToDnsType(endpoint.recordType);
    this.Key = `${endpoint.recordType}:${endpoint.dnsName}`;
    this.id = this.Key;
    this.providerContext = { endpoint };
  }

  hasSameValue(desired: DnsbaseEntry): boolean {
    // dnsEntryToEndpoint requires an ownership label, but we don't compare
    // labels here — the registry filters owned records before diffing —
    // so a stand-in is fine.
    let desiredEp: Endpoint;
    try {
      desiredEp = dnsEntryToEndpoint(desired, '_ignored_');
    } catch {
      return false;
    }
    if (desiredEp.recordType !== this.endpoint.recordType) return false;
    if (!targetsEqual(this.endpoint.targets, desiredEp.targets)) return false;
    // Cloudflare proxy comparison — only meaningful for A and CNAME, and
    // only when the user expressed an opinion in the desired entry. When
    // the desired side leaves proxy unset, we treat the current state as
    // a match (avoids fighting CLOUDFLARE_PROXIED_DEFAULT on the sidecar).
    if (isDnsAEntry(desired) || isDnsCnameEntry(desired)) {
      const desiredProxy = desired.providerOptions?.cf?.proxy;
      if (desiredProxy !== undefined) {
        const currentProxy = cfProxiedFromEndpoint(this.endpoint);
        if ((currentProxy ?? false) !== desiredProxy) return false;
      }
    }
    return true;
  }
}
