import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { IProviderRecord } from '../providers/provider-record.interface';
import { dnsEntryToEndpoint, wireTypeToDnsType } from './endpoint-mapping';
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
 * recordType. TTL is intentionally NOT compared yet — the operator
 * does not currently surface per-entry TTL through DnsbaseEntry for
 * the webhook contract, so any TTL difference would trigger a perpetual
 * update loop. That can be added later when TTL plumbing exists.
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
    return targetsEqual(this.endpoint.targets, desiredEp.targets);
  }
}
