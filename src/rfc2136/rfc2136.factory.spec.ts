import { Rfc2136Factory } from './rfc2136.factory';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { Rfc2136Record } from './types';

describe('Rfc2136Factory', () => {
  const factory = new Rfc2136Factory({
    ownershipLabel: 'docker-compose-external-dns:1',
    defaultTtl: 3600,
    minTtl: 60,
  });

  describe('buildCreateChangeSet', () => {
    it('builds add for data + ownership TXT with NXRRSET prerequisites', () => {
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.example.com',
        address: '10.1.2.3',
      });
      const cs = factory.buildCreateChangeSet(entry, 300);
      expect(cs.changes).toHaveLength(2);
      expect(cs.changes[0]).toMatchObject({
        op: 'add',
        record: {
          type: 'A',
          name: 'app.example.com',
          value: '10.1.2.3',
          ttl: 300,
        },
      });
      expect(cs.changes[1]).toMatchObject({
        op: 'add',
        record: {
          type: 'TXT',
          name: 'dnsync-a.app.example.com',
          value: '"owned-by=docker-compose-external-dns:1"',
        },
      });
      expect(cs.prerequisites).toEqual([
        { kind: 'NXRRSET', name: 'app.example.com', type: 'A' },
        { kind: 'NXRRSET', name: 'dnsync-a.app.example.com', type: 'TXT' },
      ]);
    });

    it('clamps TTL below min to minTtl', () => {
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.example.com',
        address: '10.1.2.3',
      });
      const cs = factory.buildCreateChangeSet(entry, 5);
      expect(cs.changes[0].record.ttl).toBe(60);
    });

    it('uses defaultTtl when ttl is undefined', () => {
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.example.com',
        address: '10.1.2.3',
      });
      const cs = factory.buildCreateChangeSet(entry, undefined);
      expect(cs.changes[0].record.ttl).toBe(3600);
    });
  });

  describe('buildUpdateChangeSet', () => {
    it('builds delete-old + add-new for data record only (TXT unchanged)', () => {
      const oldRec: Rfc2136Record = {
        name: 'app.example.com',
        type: 'A',
        ttl: 300,
        value: '10.1.2.3',
      };
      const desired = Object.assign(new DnsaEntry(), {
        name: 'app.example.com',
        address: '10.1.2.99',
      });
      const cs = factory.buildUpdateChangeSet(oldRec, desired, 300);
      expect(cs.changes).toEqual([
        { op: 'delete', record: { ...oldRec } },
        { op: 'add', record: { ...oldRec, value: '10.1.2.99' } },
      ]);
      expect(cs.prerequisites).toEqual([
        {
          kind: 'YXRRSET',
          name: 'dnsync-a.app.example.com',
          type: 'TXT',
          value: '"owned-by=docker-compose-external-dns:1"',
        },
      ]);
    });
  });

  describe('buildDeleteChangeSet', () => {
    it('builds delete for data + ownership TXT', () => {
      const rec: Rfc2136Record = {
        name: 'app.example.com',
        type: 'A',
        ttl: 300,
        value: '10.1.2.3',
      };
      const cs = factory.buildDeleteChangeSet(rec);
      expect(cs.changes).toEqual([
        { op: 'delete', record: { ...rec } },
        {
          op: 'delete',
          record: {
            name: 'dnsync-a.app.example.com',
            type: 'TXT',
            ttl: 0,
            value: '"owned-by=docker-compose-external-dns:1"',
          },
        },
      ]);
      expect(cs.prerequisites).toEqual([
        {
          kind: 'YXRRSET',
          name: 'dnsync-a.app.example.com',
          type: 'TXT',
          value: '"owned-by=docker-compose-external-dns:1"',
        },
      ]);
    });
  });

  describe('CNAME-specific value formatting', () => {
    it('appends trailing dot for CNAME target', () => {
      const entry = Object.assign(new DnsCnameEntry(), {
        name: 'alias.example.com',
        target: 'target.example.com',
      });
      const cs = factory.buildCreateChangeSet(entry, 300);
      expect(cs.changes[0].record.value).toBe('target.example.com.');
    });
  });
});
