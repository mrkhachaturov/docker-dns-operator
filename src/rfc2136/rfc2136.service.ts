import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsAaaaEntry } from '../dto/dnsaaaa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry } from '../dto/dnsns-entry';
import { IDnsProvider } from '../providers/dns-provider.interface';
import { IProviderRecord } from '../providers/provider-record.interface';
import { ConsoleLoggerService } from '../logger.service';
import { Rfc2136Factory } from './rfc2136.factory';
import { Rfc2136ProviderRecord } from './rfc2136-provider-record';
import { Rfc2136TransportClient } from './transport-client';
import { ZoneQueue } from './zone-queue';
import {
  ApplyRequest,
  ApplyResponse,
  Rfc2136Record,
  Rfc2136RecordType,
} from './types';

interface ResolvedConfig {
  transportUrl: string;
  authMode: 'gss-tsig';
  hosts: string[];
  port: number;
  zones: string[];
  defaultTtl: number;
  minTtl: number;
  axfrTimeoutMs: number;
  updateTimeoutMs: number;
  circuitBreakerThreshold: number;
  dryRun: boolean;
  taxfr: boolean;
  domainFilter: string[];
}

const FAILOVER_RCODES = new Set(['SERVFAIL', 'REFUSED', 'NOTAUTH']);

@Injectable()
export class Rfc2136Service implements IDnsProvider {
  readonly providerKey = 'rfc2136';

  private resolved?: ResolvedConfig;

  private readonly zoneQueue = new ZoneQueue();

  private unhealthyZonesThisCycle = new Set<string>();

  private pinnedDcForZone = new Map<string, string>();

  private availableDcsThisCycle: string[] = [];

  private axfrCache = new Map<string, Rfc2136ProviderRecord[]>();

  private rawAxfrCache = new Map<string, Rfc2136Record[]>();

  private dcConsecutiveFailures = new Map<string, number>();

  private dcCircuitOpenUntil = new Map<string, number>();

  private orphanOwnershipNames = new Set<string>();

  private ownershipLabel = '';

  constructor(
    private readonly config: ConfigService,
    private readonly transport: Rfc2136TransportClient,
    private readonly factory: Rfc2136Factory,
    private readonly logger: ConsoleLoggerService,
  ) {}

  isConfigured(): boolean {
    const required = [
      'RFC2136_TRANSPORT_URL',
      'RFC2136_AUTH_MODE',
      'RFC2136_HOSTS',
      'RFC2136_ZONES',
      'RFC2136_KERBEROS_REALM',
      'RFC2136_KERBEROS_PRINCIPAL',
      'RFC2136_KEYTAB_FILE',
    ];
    return required.every((k) => !!this.config.get<string>(k));
  }

  initialize(): void {
    if (!this.isConfigured()) return;
    const domainFilterRaw = this.config.get<string>('RFC2136_DOMAIN_FILTER');
    this.resolved = {
      transportUrl: this.config.get<string>('RFC2136_TRANSPORT_URL')!,
      authMode: 'gss-tsig',
      hosts: this.config
        .get<string>('RFC2136_HOSTS')!
        .split(',')
        .map((h) => h.trim()),
      port: Number(this.config.get('RFC2136_PORT') ?? 53),
      zones: this.config
        .get<string>('RFC2136_ZONES')!
        .split(',')
        .map((z) => z.trim().replace(/\.$/, '')),
      defaultTtl: Number(this.config.get('RFC2136_DEFAULT_TTL') ?? 3600),
      minTtl: Number(this.config.get('RFC2136_MIN_TTL') ?? 60),
      axfrTimeoutMs:
        Number(this.config.get('RFC2136_AXFR_TIMEOUT_SECONDS') ?? 30) * 1000,
      updateTimeoutMs:
        Number(this.config.get('RFC2136_UPDATE_TIMEOUT_SECONDS') ?? 15) * 1000,
      circuitBreakerThreshold: Number(
        this.config.get('RFC2136_CIRCUIT_BREAKER_THRESHOLD') ?? 3,
      ),
      dryRun: this.config.get<boolean>('RFC2136_DRY_RUN') === true,
      taxfr: this.config.get<boolean>('RFC2136_TAXFR') !== false,
      domainFilter: domainFilterRaw
        ? domainFilterRaw
            .split(',')
            .map((s) => s.trim().toLowerCase().replace(/\.$/, ''))
            .filter((s) => s.length > 0)
        : [],
    };
    const projectLabel =
      this.config.get<string>('PROJECT_LABEL') ?? 'docker-dns-operator';
    const instanceId = this.config.get<string>('INSTANCE_ID') ?? '1';
    this.ownershipLabel = `${projectLabel}:${instanceId}`;
    this.zoneQueue.setGate((zone) => !this.unhealthyZonesThisCycle.has(zone));
    this.logger.log(
      `[rfc2136] initialised — hosts=${this.resolved.hosts.join(',')} zones=${this.resolved.zones.join(',')} taxfr=${this.resolved.taxfr}${this.resolved.domainFilter.length ? ` domain-filter=${this.resolved.domainFilter.join(',')}` : ''}`,
    );
  }

  /** Probes the sidecar `/healthz` with bounded retry. Throws on failure — call from startup, not per-cycle. */
  async probeSidecar(maxAttempts = 5, backoffMs = 2000): Promise<void> {
    for (let i = 1; i <= maxAttempts; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await this.transport.health(5_000);
      if ('kerberos' in res && res.ok && res.kerberos === 'ready') return;
      this.logger.warn(
        `[rfc2136] sidecar healthz attempt ${i}/${maxAttempts} not ready: ${JSON.stringify(res)}`,
      );
      if (i < maxAttempts) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => {
          setTimeout(r, backoffMs);
        });
      }
    }
    throw new Error('rfc2136 sidecar /healthz never returned ready');
  }

  async prepareForJob(): Promise<void> {
    if (!this.resolved) return;

    this.unhealthyZonesThisCycle = new Set();
    this.pinnedDcForZone.clear();
    this.axfrCache.clear();
    this.rawAxfrCache.clear();
    this.orphanOwnershipNames.clear();

    const now = Date.now();
    const availableDcs = this.resolved.hosts.filter((dc) => {
      const openUntil = this.dcCircuitOpenUntil.get(dc) ?? 0;
      if (openUntil > now) return false;
      if (openUntil > 0) {
        this.dcCircuitOpenUntil.delete(dc);
        this.dcConsecutiveFailures.set(dc, 0);
        this.logger.log(`[rfc2136] DC ${dc} circuit re-closed`);
      }
      return true;
    });
    this.availableDcsThisCycle = availableDcs;

    if (!this.resolved.taxfr) {
      // TAXFR disabled — pin first available DC per zone deterministically.
      // No reads — we rely on UPDATE prerequisites for collision detection.
      if (availableDcs.length === 0) {
        // eslint-disable-next-line no-restricted-syntax
        for (const zone of this.resolved.zones) {
          this.unhealthyZonesThisCycle.add(zone);
        }
        this.logger.error(
          '[rfc2136] no available DCs (all circuits open) — zones unhealthy this cycle',
        );
        return;
      }
      // eslint-disable-next-line no-restricted-syntax
      for (const zone of this.resolved.zones) {
        this.pinnedDcForZone.set(zone, availableDcs[0]);
      }
      return;
    }

    const dcSuccessfulThisCycle = new Set<string>();
    const dcTriedThisCycle = new Set<string>();

    // eslint-disable-next-line no-restricted-syntax
    for (const zone of this.resolved.zones) {
      let pinned: string | undefined;
      // eslint-disable-next-line no-restricted-syntax
      for (const dc of availableDcs) {
        dcTriedThisCycle.add(dc);
        // eslint-disable-next-line no-await-in-loop
        const res = await this.transport.getRecords(
          { host: dc, port: this.resolved.port, zone },
          this.resolved.axfrTimeoutMs,
        );
        if (res.ok) {
          pinned = dc;
          dcSuccessfulThisCycle.add(dc);
          this.rawAxfrCache.set(zone, res.records);
          break;
        }
        this.logger.warn(
          `[rfc2136] AXFR failed dc=${dc} zone=${zone} phase=${res.phase} message=${res.message}`,
        );
      }
      if (pinned) {
        this.pinnedDcForZone.set(zone, pinned);
      } else {
        this.unhealthyZonesThisCycle.add(zone);
        this.logger.error(
          `[rfc2136] zone ${zone} unhealthy this cycle — no DC could serve AXFR`,
        );
      }
    }

    this.detectOrphanOwnershipTxts();

    // eslint-disable-next-line no-restricted-syntax
    for (const dc of dcTriedThisCycle) {
      if (dcSuccessfulThisCycle.has(dc)) {
        this.dcConsecutiveFailures.set(dc, 0);
        // eslint-disable-next-line no-continue
        continue;
      }
      const fails = (this.dcConsecutiveFailures.get(dc) ?? 0) + 1;
      this.dcConsecutiveFailures.set(dc, fails);
      if (
        fails >= this.resolved.circuitBreakerThreshold &&
        !this.dcCircuitOpenUntil.has(dc)
      ) {
        const previousOpens = Math.max(
          0,
          fails - this.resolved.circuitBreakerThreshold,
        );
        const cooldownMs = Math.min(60_000 * 2 ** previousOpens, 3_600_000);
        this.dcCircuitOpenUntil.set(dc, Date.now() + cooldownMs);
        this.logger.warn(
          `[rfc2136] DC ${dc} circuit opened for ${cooldownMs}ms after ${fails} consecutive failing cycles`,
        );
      }
    }
  }

  private detectOrphanOwnershipTxts(): void {
    const ownershipValue = `"owned-by=${this.ownershipLabel}"`;
    this.rawAxfrCache.forEach((records, zone) => {
      const byName = new Map<string, Rfc2136Record[]>();
      // eslint-disable-next-line no-restricted-syntax
      for (const r of records) {
        const arr = byName.get(r.name) ?? [];
        arr.push(r);
        byName.set(r.name, arr);
      }
      // eslint-disable-next-line no-restricted-syntax
      for (const r of records) {
        // eslint-disable-next-line no-continue
        if (r.type !== 'TXT' || r.value !== ownershipValue) continue;
        const m = r.name.match(/^ddo-([a-z]+)\.(.+)$/);
        // eslint-disable-next-line no-continue
        if (!m) continue;
        const [, typeLc, ownedName] = m;
        const ownedType = typeLc.toUpperCase();
        const siblings = byName.get(ownedName) ?? [];
        const dataExists = siblings.some((s) => s.type === ownedType);
        if (!dataExists) {
          this.orphanOwnershipNames.add(r.name);
          this.logger.warn(
            `[rfc2136] orphan ownership TXT detected zone=${zone} name=${r.name} — will allow recreate without NXRRSET prereq on this TXT`,
          );
        }
      }
    });
  }

  async getRecords(): Promise<IProviderRecord[]> {
    if (!this.resolved) return [];
    if (!this.resolved.taxfr) return [];

    const ownershipValue = `"owned-by=${this.ownershipLabel}"`;
    const out: Rfc2136ProviderRecord[] = [];

    // eslint-disable-next-line no-restricted-syntax
    for (const zone of this.resolved.zones) {
      // eslint-disable-next-line no-continue
      if (this.unhealthyZonesThisCycle.has(zone)) continue;
      const raw = this.rawAxfrCache.get(zone) ?? [];

      const ownershipIndex = new Map<string, Set<string>>();
      // eslint-disable-next-line no-restricted-syntax
      for (const r of raw) {
        // eslint-disable-next-line no-continue
        if (r.type !== 'TXT') continue;
        // eslint-disable-next-line no-continue
        if (r.value !== ownershipValue) continue;
        const m = r.name.match(/^ddo-([a-z]+)\.(.+)$/);
        // eslint-disable-next-line no-continue
        if (!m) continue;
        const [, typeLc, ownedName] = m;
        const ownedType = typeLc.toUpperCase();
        const types = ownershipIndex.get(ownedName) ?? new Set<string>();
        types.add(ownedType);
        ownershipIndex.set(ownedName, types);
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const r of raw) {
        // eslint-disable-next-line no-continue
        if (r.type === 'TXT') continue;
        // eslint-disable-next-line no-continue
        if (!this.matchesDomainFilter(r.name)) continue;
        const types = ownershipIndex.get(r.name);
        // eslint-disable-next-line no-continue
        if (!types || !types.has(r.type)) continue;
        out.push(
          new Rfc2136ProviderRecord(
            {
              name: r.name,
              type: r.type as Rfc2136RecordType,
              ttl: r.ttl,
              value: r.value,
            },
            zone,
            {
              defaultTtl: this.resolved!.defaultTtl,
              minTtl: this.resolved!.minTtl,
            },
          ),
        );
      }
    }

    return out;
  }

  async createEntry(entry: DnsbaseEntry): Promise<void> {
    if (!this.resolved) return;
    if (!this.matchesDomainFilter(entry.name)) {
      this.logger.warn(
        `[rfc2136] entry ${entry.name} excluded by RFC2136_DOMAIN_FILTER — skipping`,
      );
      return;
    }
    const zone = this.zoneFor(entry.name);
    if (!zone) {
      this.logger.warn(
        `[rfc2136] no configured zone for ${entry.name} — skipping`,
      );
      return;
    }
    await this.zoneQueue.enqueue(zone, async () => {
      const raw = this.rawAxfrCache.get(zone) ?? [];
      const targetType = this.entryTypeName(entry);
      const ownershipName = `ddo-${targetType.toLowerCase()}.${entry.name.toLowerCase()}`;
      const skipOwnershipTxtPrereq =
        this.orphanOwnershipNames.has(ownershipName);

      // Collision detection: only meaningful when we have AXFR cache (TAXFR=true).
      // RFC 1034 §3.6.2: CNAME is mutually exclusive with all other types at the same name.
      if (this.resolved!.taxfr) {
        const sameName = raw.filter(
          (r) => r.name.toLowerCase() === entry.name.toLowerCase(),
        );
        const existingSameType = sameName.find((r) => r.type === targetType);
        const existingCname = sameName.find((r) => r.type === 'CNAME');
        const wantsCname = targetType === 'CNAME';
        const wantsNonCnameWithCname = !wantsCname && !!existingCname;
        const wantsCnameWithAnyOther =
          wantsCname && sameName.some((r) => r.type !== 'CNAME');

        if (wantsNonCnameWithCname || wantsCnameWithAnyOther) {
          this.logger.warn(
            `[rfc2136] create collision — RFC1034 §3.6.2 conflict at ${entry.name} (want=${targetType}, existing types=${[
              ...new Set(sameName.map((r) => r.type)),
            ].join(',')}) — skipping`,
          );
          return;
        }

        if (existingSameType) {
          const hasOurOwnership = raw.some(
            (r) =>
              r.name === ownershipName &&
              r.type === 'TXT' &&
              r.value === `"owned-by=${this.ownershipLabel}"`,
          );
          if (!hasOurOwnership) {
            this.logger.warn(
              `[rfc2136] create collision — unowned ${targetType} record exists at ${entry.name} — skipping`,
            );
            return;
          }
        }
      }

      const ttl = entry.providerOptions?.rfc2136?.ttl;
      const cs = this.factory.buildCreateChangeSet(entry, ttl, {
        skipOwnershipTxtPrereq,
      });
      if (this.resolved!.dryRun) {
        this.logger.log(
          `[rfc2136][dry-run] would create ${entry.name} type=${targetType}`,
        );
        return;
      }
      await this.applyWithFailover(zone, {
        prerequisites: cs.prerequisites,
        changes: cs.changes,
        labelForLog: `create name=${entry.name}`,
      });
    });
  }

  async updateEntry(
    old: IProviderRecord,
    desired: DnsbaseEntry,
  ): Promise<void> {
    if (!this.resolved) return;
    if (!this.matchesDomainFilter(desired.name)) {
      this.logger.warn(
        `[rfc2136] entry ${desired.name} excluded by RFC2136_DOMAIN_FILTER — skipping update`,
      );
      return;
    }
    const { zone } = old.providerContext as { zone: string };
    await this.zoneQueue.enqueue(zone, async () => {
      const oldRaw = (old.providerContext as { raw: Rfc2136Record }).raw;
      const ttl = desired.providerOptions?.rfc2136?.ttl;
      const cs = this.factory.buildUpdateChangeSet(oldRaw, desired, ttl);
      if (this.resolved!.dryRun) {
        this.logger.log(`[rfc2136][dry-run] would update ${desired.name}`);
        return;
      }
      await this.applyWithFailover(zone, {
        prerequisites: cs.prerequisites,
        changes: cs.changes,
        labelForLog: `update name=${desired.name}`,
      });
    });
  }

  async deleteEntry(old: IProviderRecord): Promise<void> {
    if (!this.resolved) return;
    if (!this.matchesDomainFilter(old.name)) {
      this.logger.warn(
        `[rfc2136] entry ${old.name} excluded by RFC2136_DOMAIN_FILTER — skipping delete`,
      );
      return;
    }
    const { zone } = old.providerContext as { zone: string };
    await this.zoneQueue.enqueue(zone, async () => {
      const oldRaw = (old.providerContext as { raw: Rfc2136Record }).raw;
      const cs = this.factory.buildDeleteChangeSet(oldRaw);
      if (this.resolved!.dryRun) {
        this.logger.log(`[rfc2136][dry-run] would delete ${old.name}`);
        return;
      }
      await this.applyWithFailover(zone, {
        prerequisites: cs.prerequisites,
        changes: cs.changes,
        labelForLog: `delete name=${old.name}`,
      });
    });
  }

  /**
   * Sends an apply to the pinned DC; on retryable/failover-eligible failures,
   * walks remaining `availableDcsThisCycle` in order. Only marks the zone
   * unhealthy after all DCs are exhausted for this single op.
   *
   * Mirrors k8s SendMessage (provider/rfc2136/rfc2136.go:546-602).
   */
  private async applyWithFailover(
    zone: string,
    payload: {
      prerequisites: ApplyRequest['prerequisites'];
      changes: ApplyRequest['changes'];
      labelForLog: string;
    },
  ): Promise<void> {
    const pinned = this.pinnedDcForZone.get(zone);
    const order: string[] = [];
    if (pinned) order.push(pinned);
    // eslint-disable-next-line no-restricted-syntax
    for (const dc of this.availableDcsThisCycle) {
      if (!order.includes(dc)) order.push(dc);
    }
    if (order.length === 0) {
      this.logger.error(
        `[rfc2136] ${payload.labelForLog} zone=${zone} — no DCs available`,
      );
      this.unhealthyZonesThisCycle.add(zone);
      return;
    }

    let lastFailure: Extract<ApplyResponse, { ok: false }> | undefined;
    // eslint-disable-next-line no-restricted-syntax
    for (const dc of order) {
      // eslint-disable-next-line no-await-in-loop
      const res = await this.transport.apply(
        {
          host: dc,
          port: this.resolved!.port,
          zone,
          prerequisites: payload.prerequisites,
          changes: payload.changes,
        },
        this.resolved!.updateTimeoutMs,
      );
      if (res.ok) {
        if (pinned !== dc) {
          this.pinnedDcForZone.set(zone, dc);
          this.logger.log(
            `[rfc2136] ${payload.labelForLog} zone=${zone} — failed over to dc=${dc}`,
          );
        }
        return;
      }
      lastFailure = res;
      const isFailover =
        res.retryable === true ||
        (res.rcode !== undefined && FAILOVER_RCODES.has(res.rcode));
      this.logger.warn(
        `[rfc2136] ${payload.labelForLog} zone=${zone} dc=${dc} failed phase=${res.phase} rcode=${res.rcode ?? 'none'} message=${res.message} failover=${isFailover}`,
      );
      if (!isFailover) {
        // Non-retryable, non-failover-eligible — don't try other DCs.
        break;
      }
    }

    this.logger.error(
      `[rfc2136] ${payload.labelForLog} zone=${zone} — exhausted ${order.length} DC(s) lastPhase=${lastFailure?.phase ?? 'unknown'} lastRcode=${lastFailure?.rcode ?? 'none'} lastMessage=${lastFailure?.message ?? ''}`,
    );
    this.unhealthyZonesThisCycle.add(zone);
  }

  private matchesDomainFilter(fqdn: string): boolean {
    if (!this.resolved || this.resolved.domainFilter.length === 0) return true;
    const name = fqdn.toLowerCase().replace(/\.$/, '');
    return this.resolved.domainFilter.some(
      (suffix) => name === suffix || name.endsWith(`.${suffix}`),
    );
  }

  private zoneFor(fqdn: string): string | undefined {
    const name = fqdn.toLowerCase().replace(/\.$/, '');
    const matches = (this.resolved?.zones ?? []).filter(
      (z) => name === z || name.endsWith(`.${z}`),
    );
    if (matches.length === 0) return undefined;
    return matches.sort((a, b) => b.length - a.length)[0];
  }

  // eslint-disable-next-line class-methods-use-this
  private entryTypeName(entry: DnsbaseEntry): string {
    if (entry instanceof DnsaEntry) return 'A';
    if (entry instanceof DnsAaaaEntry) return 'AAAA';
    if (entry instanceof DnsCnameEntry) return 'CNAME';
    if (entry instanceof DnsMxEntry) return 'MX';
    if (entry instanceof DnsNsEntry) return 'NS';
    return (entry.type as unknown as string) ?? DNSTypes.Unsupported;
  }
}
