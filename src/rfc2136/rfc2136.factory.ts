import { DnsbaseEntry } from '../dto/dnsbase-entry';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsAaaaEntry } from '../dto/dnsaaaa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry } from '../dto/dnsns-entry';
import {
  Change,
  Prerequisite,
  Rfc2136Record,
  Rfc2136RecordType,
} from './types';

export interface Rfc2136FactoryOptions {
  ownershipLabel: string;
  defaultTtl: number;
  minTtl: number;
}

export interface ChangeSet {
  prerequisites: Prerequisite[];
  changes: Change[];
}

export class Rfc2136Factory {
  constructor(private readonly opts: Rfc2136FactoryOptions) {}

  buildCreateChangeSet(
    entry: DnsbaseEntry,
    ttl: number | undefined,
    options: { skipOwnershipTxtPrereq?: boolean } = {},
  ): ChangeSet {
    const rec = this.entryToRecord(entry, ttl);
    const ownershipName = Rfc2136Factory.ownershipName(rec.type, rec.name);
    const ownershipTxt: Rfc2136Record = {
      name: ownershipName,
      type: 'TXT',
      ttl: rec.ttl,
      value: this.ownershipValue(),
    };
    const prerequisites: Prerequisite[] = [
      { kind: 'NXRRSET', name: rec.name, type: rec.type },
    ];
    if (!options.skipOwnershipTxtPrereq) {
      prerequisites.push({
        kind: 'NXRRSET',
        name: ownershipName,
        type: 'TXT',
      });
    }
    const changes: Change[] = [{ op: 'add', record: rec }];
    if (!options.skipOwnershipTxtPrereq) {
      changes.push({ op: 'add', record: ownershipTxt });
    }
    return { prerequisites, changes };
  }

  buildUpdateChangeSet(
    oldRec: Rfc2136Record,
    desired: DnsbaseEntry,
    ttl: number | undefined,
  ): ChangeSet {
    const newRec = this.entryToRecord(desired, ttl);
    const ownershipName = Rfc2136Factory.ownershipName(
      oldRec.type,
      oldRec.name,
    );
    return {
      prerequisites: [
        {
          kind: 'YXRRSET',
          name: ownershipName,
          type: 'TXT',
          value: this.ownershipValue(),
        },
      ],
      changes: [
        { op: 'delete', record: oldRec },
        { op: 'add', record: newRec },
      ],
    };
  }

  buildDeleteChangeSet(rec: Rfc2136Record): ChangeSet {
    const ownershipName = Rfc2136Factory.ownershipName(rec.type, rec.name);
    const ownershipTxt: Rfc2136Record = {
      name: ownershipName,
      type: 'TXT',
      ttl: 0,
      value: this.ownershipValue(),
    };
    return {
      prerequisites: [
        {
          kind: 'YXRRSET',
          name: ownershipName,
          type: 'TXT',
          value: this.ownershipValue(),
        },
      ],
      changes: [
        { op: 'delete', record: { ...rec } },
        { op: 'delete', record: ownershipTxt },
      ],
    };
  }

  private entryToRecord(
    entry: DnsbaseEntry,
    ttl: number | undefined,
  ): Rfc2136Record {
    const effectiveTtl = Math.max(
      ttl ?? this.opts.defaultTtl,
      this.opts.minTtl,
    );
    const name = entry.name.toLowerCase();
    if (entry instanceof DnsaEntry) {
      return { name, type: 'A', ttl: effectiveTtl, value: entry.address };
    }
    if (entry instanceof DnsAaaaEntry) {
      return {
        name,
        type: 'AAAA',
        ttl: effectiveTtl,
        value: entry.address.toLowerCase(),
      };
    }
    if (entry instanceof DnsCnameEntry) {
      const tgt = entry.target.toLowerCase();
      return {
        name,
        type: 'CNAME',
        ttl: effectiveTtl,
        value: tgt.endsWith('.') ? tgt : `${tgt}.`,
      };
    }
    if (entry instanceof DnsMxEntry) {
      const tgt = entry.server.toLowerCase();
      return {
        name,
        type: 'MX',
        ttl: effectiveTtl,
        value: `${entry.priority} ${tgt.endsWith('.') ? tgt : `${tgt}.`}`,
      };
    }
    if (entry instanceof DnsNsEntry) {
      const tgt = entry.server.toLowerCase();
      return {
        name,
        type: 'NS',
        ttl: effectiveTtl,
        value: tgt.endsWith('.') ? tgt : `${tgt}.`,
      };
    }
    throw new Error(`Unsupported DNS type for rfc2136: ${entry.type}`);
  }

  private static ownershipName(type: Rfc2136RecordType, name: string): string {
    return `ddo-${type.toLowerCase()}.${name}`;
  }

  private ownershipValue(): string {
    return `"owned-by=${this.opts.ownershipLabel}"`;
  }
}
