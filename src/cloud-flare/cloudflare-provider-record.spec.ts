import { CloudflareProviderRecord } from './cloudflare-provider-record';
import { DNSTypes } from '../dto/dnsbase-entry';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry } from '../dto/dnsns-entry';

function makeRecord(overrides: Partial<CloudflareProviderRecord> = {}): CloudflareProviderRecord {
  const r = new CloudflareProviderRecord();
  r.id = overrides.id ?? 'rec-id';
  r.name = overrides.name ?? 'test.example.com';
  r.type = overrides.type ?? DNSTypes.A;
  r.zoneId = overrides.zoneId ?? 'zone-1';
  r.address = overrides.address;
  r.target = overrides.target;
  r.server = overrides.server;
  r.priority = overrides.priority;
  r.proxy = overrides.proxy;
  return r;
}

describe('CloudflareProviderRecord', () => {
  describe('Key', () => {
    it('should produce type:name key', () => {
      const r = makeRecord({ type: DNSTypes.A, name: 'foo.com' });
      expect(r.Key).toBe('A:foo.com');
    });
  });

  describe('providerContext', () => {
    it('should expose zoneId in providerContext', () => {
      const r = makeRecord({ zoneId: 'zone-abc' });
      expect(r.providerContext).toEqual({ zoneId: 'zone-abc' });
    });
  });

  describe('hasSameValue', () => {
    describe('A record', () => {
      it('returns true when address and proxy match', () => {
        const record = makeRecord({ type: DNSTypes.A, address: '1.2.3.4', proxy: false });
        const entry = new DnsaEntry();
        entry.type = DNSTypes.A;
        entry.name = 'test.example.com';
        entry.address = '1.2.3.4';
        entry.providerOptions = { cf: { proxy: false } };
        expect(record.hasSameValue(entry)).toBe(true);
      });

      it('returns false when address differs', () => {
        const record = makeRecord({ type: DNSTypes.A, address: '1.2.3.4', proxy: false });
        const entry = new DnsaEntry();
        entry.address = '5.5.5.5';
        entry.providerOptions = { cf: { proxy: false } };
        expect(record.hasSameValue(entry)).toBe(false);
      });

      it('returns false when proxy differs', () => {
        const record = makeRecord({ type: DNSTypes.A, address: '1.2.3.4', proxy: false });
        const entry = new DnsaEntry();
        entry.address = '1.2.3.4';
        entry.providerOptions = { cf: { proxy: true } };
        expect(record.hasSameValue(entry)).toBe(false);
      });
    });

    describe('CNAME record', () => {
      it('returns true when target and proxy match', () => {
        const record = makeRecord({ type: DNSTypes.CNAME, target: 'other.com', proxy: true });
        const entry = new DnsCnameEntry();
        entry.type = DNSTypes.CNAME;
        entry.target = 'other.com';
        entry.providerOptions = { cf: { proxy: true } };
        expect(record.hasSameValue(entry)).toBe(true);
      });
    });

    describe('MX record', () => {
      it('returns true when server and priority match', () => {
        const record = makeRecord({ type: DNSTypes.MX, server: 'mx.mail.com', priority: 10 });
        const entry = new DnsMxEntry();
        entry.type = DNSTypes.MX;
        entry.server = 'mx.mail.com';
        entry.priority = 10;
        expect(record.hasSameValue(entry)).toBe(true);
      });
    });

    describe('NS record', () => {
      it('returns true when server matches', () => {
        const record = makeRecord({ type: DNSTypes.NS, server: 'ns.mail.com' });
        const entry = new DnsNsEntry();
        entry.type = DNSTypes.NS;
        entry.server = 'ns.mail.com';
        expect(record.hasSameValue(entry)).toBe(true);
      });
    });

    describe('Unsupported record', () => {
      it('returns false for unsupported type', () => {
        const record = makeRecord({ type: DNSTypes.Unsupported });
        const entry = new DnsaEntry();
        entry.type = DNSTypes.Unsupported;
        expect(record.hasSameValue(entry)).toBe(false);
      });
    });
  });
});
