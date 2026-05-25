import { plainToInstance } from 'class-transformer';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DNSTypes } from '../dto/dnsbase-entry';
import { Endpoint } from './types';
import { WebhookProviderRecord } from './webhook-provider-record';

const wire = (overrides: Partial<Endpoint>): Endpoint => ({
  dnsName: 'app.example.com',
  recordType: 'A',
  targets: ['10.1.2.3'],
  ...overrides,
});

describe('WebhookProviderRecord', () => {
  describe('IProviderRecord shape', () => {
    it('builds id, name, type, Key from the wire endpoint', () => {
      const rec = new WebhookProviderRecord(wire({}));
      expect(rec.name).toBe('app.example.com');
      expect(rec.type).toBe(DNSTypes.A);
      expect(rec.Key).toBe('A:app.example.com');
      expect(rec.id).toBe('A:app.example.com');
    });

    it('Unsupported record type still constructs (filtered out by registry layer)', () => {
      const rec = new WebhookProviderRecord(
        wire({ recordType: 'SRV', targets: ['0 5 5060 sip.example.com'] }),
      );
      expect(rec.type).toBe(DNSTypes.Unsupported);
    });

    it('exposes the raw endpoint via providerContext', () => {
      const ep = wire({});
      const rec = new WebhookProviderRecord(ep);
      expect(rec.providerContext).toEqual({ endpoint: ep });
    });
  });

  describe('hasSameValue — A', () => {
    it('matches when address is identical', () => {
      const desired = plainToInstance(DnsaEntry, {
        type: DNSTypes.A,
        name: 'app.example.com',
        address: '10.1.2.3',
      });
      const rec = new WebhookProviderRecord(wire({ targets: ['10.1.2.3'] }));
      expect(rec.hasSameValue(desired)).toBe(true);
    });

    it('differs when address changes', () => {
      const desired = plainToInstance(DnsaEntry, {
        type: DNSTypes.A,
        name: 'app.example.com',
        address: '10.9.9.9',
      });
      const rec = new WebhookProviderRecord(wire({ targets: ['10.1.2.3'] }));
      expect(rec.hasSameValue(desired)).toBe(false);
    });
  });

  describe('hasSameValue — CNAME', () => {
    it('matches when target is identical', () => {
      const desired = plainToInstance(DnsCnameEntry, {
        type: DNSTypes.CNAME,
        name: 'www.example.com',
        target: 'app.example.com',
      });
      const rec = new WebhookProviderRecord(
        wire({
          dnsName: 'www.example.com',
          recordType: 'CNAME',
          targets: ['app.example.com'],
        }),
      );
      expect(rec.hasSameValue(desired)).toBe(true);
    });

    it('is case-insensitive on the target hostname', () => {
      const desired = plainToInstance(DnsCnameEntry, {
        type: DNSTypes.CNAME,
        name: 'www.example.com',
        target: 'APP.example.com',
      });
      const rec = new WebhookProviderRecord(
        wire({
          dnsName: 'www.example.com',
          recordType: 'CNAME',
          targets: ['app.example.com'],
        }),
      );
      expect(rec.hasSameValue(desired)).toBe(true);
    });
  });

  describe('hasSameValue — MX', () => {
    it('matches when priority and server are identical', () => {
      const desired = plainToInstance(DnsMxEntry, {
        type: DNSTypes.MX,
        name: 'example.com',
        server: 'mail.example.com',
        priority: 10,
      });
      const rec = new WebhookProviderRecord(
        wire({
          dnsName: 'example.com',
          recordType: 'MX',
          targets: ['10 mail.example.com'],
        }),
      );
      expect(rec.hasSameValue(desired)).toBe(true);
    });

    it('differs when priority changes', () => {
      const desired = plainToInstance(DnsMxEntry, {
        type: DNSTypes.MX,
        name: 'example.com',
        server: 'mail.example.com',
        priority: 20,
      });
      const rec = new WebhookProviderRecord(
        wire({
          dnsName: 'example.com',
          recordType: 'MX',
          targets: ['10 mail.example.com'],
        }),
      );
      expect(rec.hasSameValue(desired)).toBe(false);
    });
  });

  describe('hasSameValue — Cloudflare proxy round-trip', () => {
    const proxiedKey = 'external-dns.alpha.kubernetes.io/cloudflare-proxied';

    it('returns false when desired cf.proxy=true but current is false', () => {
      const desired = plainToInstance(DnsaEntry, {
        type: DNSTypes.A,
        name: 'app.example.com',
        address: '10.1.2.3',
        providerOptions: { cf: { proxy: true } },
      });
      const rec = new WebhookProviderRecord(
        wire({
          targets: ['10.1.2.3'],
          providerSpecific: [{ name: proxiedKey, value: 'false' }],
        }),
      );
      expect(rec.hasSameValue(desired)).toBe(false);
    });

    it('returns true when both desired and current proxy=true', () => {
      const desired = plainToInstance(DnsaEntry, {
        type: DNSTypes.A,
        name: 'app.example.com',
        address: '10.1.2.3',
        providerOptions: { cf: { proxy: true } },
      });
      const rec = new WebhookProviderRecord(
        wire({
          targets: ['10.1.2.3'],
          providerSpecific: [{ name: proxiedKey, value: 'true' }],
        }),
      );
      expect(rec.hasSameValue(desired)).toBe(true);
    });

    it('treats desired with no proxy opinion as matching any current proxy state', () => {
      const desired = plainToInstance(DnsaEntry, {
        type: DNSTypes.A,
        name: 'app.example.com',
        address: '10.1.2.3',
      });
      const rec = new WebhookProviderRecord(
        wire({
          targets: ['10.1.2.3'],
          providerSpecific: [{ name: proxiedKey, value: 'true' }],
        }),
      );
      expect(rec.hasSameValue(desired)).toBe(true);
    });
  });

  describe('hasSameValue — type mismatch', () => {
    it('a record with type=A never matches a desired CNAME', () => {
      const desired = plainToInstance(DnsCnameEntry, {
        type: DNSTypes.CNAME,
        name: 'app.example.com',
        target: 'something.example.com',
      });
      const rec = new WebhookProviderRecord(
        wire({ recordType: 'A', targets: ['10.1.2.3'] }),
      );
      expect(rec.hasSameValue(desired)).toBe(false);
    });
  });
});
