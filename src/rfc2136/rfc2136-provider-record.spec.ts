import { Rfc2136ProviderRecord } from './rfc2136-provider-record';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsAaaaEntry } from '../dto/dnsaaaa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry } from '../dto/dnsns-entry';
import { Rfc2136Record } from './types';

describe('Rfc2136ProviderRecord', () => {
  const make = (rec: Rfc2136Record) =>
    new Rfc2136ProviderRecord(rec, 'example.com', {
      defaultTtl: 3600,
      minTtl: 60,
    });

  it('exposes Key as "type:name"', () => {
    const r = make({
      name: 'a.example.com',
      type: 'A',
      ttl: 300,
      value: '10.0.0.1',
    });
    expect(r.Key).toBe('A:a.example.com');
  });

  it('A record hasSameValue matches DnsaEntry on address', () => {
    const r = make({
      name: 'a.example.com',
      type: 'A',
      ttl: 300,
      value: '10.0.0.1',
    });
    const same = Object.assign(new DnsaEntry(), {
      name: 'a.example.com',
      address: '10.0.0.1',
    });
    const diff = Object.assign(new DnsaEntry(), {
      name: 'a.example.com',
      address: '10.0.0.2',
    });
    expect(r.hasSameValue(same)).toBe(true);
    expect(r.hasSameValue(diff)).toBe(false);
  });

  it('AAAA case-insensitive compare', () => {
    const r = make({
      name: 'v6.example.com',
      type: 'AAAA',
      ttl: 300,
      value: '2001:db8::1',
    });
    const same = Object.assign(new DnsAaaaEntry(), {
      name: 'v6.example.com',
      address: '2001:DB8::1',
    });
    expect(r.hasSameValue(same)).toBe(true);
  });

  it('CNAME compares with normalized trailing dot', () => {
    const r = make({
      name: 'alias.example.com',
      type: 'CNAME',
      ttl: 300,
      value: 'target.example.com.',
    });
    const same = Object.assign(new DnsCnameEntry(), {
      name: 'alias.example.com',
      target: 'target.example.com',
    });
    expect(r.hasSameValue(same)).toBe(true);
  });

  it('MX compares priority + target', () => {
    const r = make({
      name: 'mail.example.com',
      type: 'MX',
      ttl: 300,
      value: '10 smtp.example.com.',
    });
    const same = Object.assign(new DnsMxEntry(), {
      name: 'mail.example.com',
      priority: 10,
      server: 'smtp.example.com',
    });
    const diffPri = Object.assign(new DnsMxEntry(), {
      name: 'mail.example.com',
      priority: 20,
      server: 'smtp.example.com',
    });
    expect(r.hasSameValue(same)).toBe(true);
    expect(r.hasSameValue(diffPri)).toBe(false);
  });

  it('NS compares target with trailing dot', () => {
    const r = make({
      name: 'sub.example.com',
      type: 'NS',
      ttl: 300,
      value: 'ns1.example.com.',
    });
    const same = Object.assign(new DnsNsEntry(), {
      name: 'sub.example.com',
      server: 'ns1.example.com',
    });
    expect(r.hasSameValue(same)).toBe(true);
  });

  it('providerContext exposes zone for update/delete routing', () => {
    const r = make({
      name: 'a.example.com',
      type: 'A',
      ttl: 300,
      value: '10.0.0.1',
    });
    expect(r.providerContext).toEqual({
      zone: 'example.com',
      raw: expect.any(Object),
    });
  });

  describe('TTL equality', () => {
    it('returns false when value matches but effective TTL differs', () => {
      const r = make({
        name: 'a.example.com',
        type: 'A',
        ttl: 300,
        value: '10.0.0.1',
      });
      const desired = Object.assign(new DnsaEntry(), {
        name: 'a.example.com',
        address: '10.0.0.1',
        providerOptions: { rfc2136: { ttl: 900 } },
      });
      expect(r.hasSameValue(desired)).toBe(false);
    });

    it('returns true when desired ttl below minTtl resolves to same floor as raw at floor', () => {
      const r = make({
        name: 'a.example.com',
        type: 'A',
        ttl: 10,
        value: '10.0.0.1',
      });
      const desired = Object.assign(new DnsaEntry(), {
        name: 'a.example.com',
        address: '10.0.0.1',
        providerOptions: { rfc2136: { ttl: 5 } },
      });
      expect(r.hasSameValue(desired)).toBe(true);
    });

    it('returns true when desired omits ttl and raw matches defaultTtl', () => {
      const r = make({
        name: 'a.example.com',
        type: 'A',
        ttl: 3600,
        value: '10.0.0.1',
      });
      const desired = Object.assign(new DnsaEntry(), {
        name: 'a.example.com',
        address: '10.0.0.1',
      });
      expect(r.hasSameValue(desired)).toBe(true);
    });
  });
});
