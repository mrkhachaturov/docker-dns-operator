import { plainToInstance } from 'class-transformer';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsAaaaEntry } from '../dto/dnsaaaa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry } from '../dto/dnsns-entry';
import { DNSTypes } from '../dto/dnsbase-entry';
import {
  CLOUDFLARE_PROXIED_KEY,
  OWNER_LABEL_KEY,
  cfProxiedFromEndpoint,
  dnsEntryToEndpoint,
} from './endpoint-mapping';

const ownership = 'docker-dns-operator:home';

describe('dnsEntryToEndpoint', () => {
  it('maps an A record', () => {
    const entry = plainToInstance(DnsaEntry, {
      type: DNSTypes.A,
      name: 'app.example.com',
      address: '10.1.2.3',
    });

    const ep = dnsEntryToEndpoint(entry, ownership);

    expect(ep).toEqual({
      dnsName: 'app.example.com',
      recordType: 'A',
      targets: ['10.1.2.3'],
      labels: { [OWNER_LABEL_KEY]: ownership },
    });
  });

  it('maps an AAAA record', () => {
    const entry = plainToInstance(DnsAaaaEntry, {
      type: DNSTypes.AAAA,
      name: 'app.example.com',
      address: '2001:db8::1',
    });

    const ep = dnsEntryToEndpoint(entry, ownership);

    expect(ep.recordType).toBe('AAAA');
    expect(ep.targets).toEqual(['2001:db8::1']);
  });

  it('maps a CNAME record', () => {
    const entry = plainToInstance(DnsCnameEntry, {
      type: DNSTypes.CNAME,
      name: 'www.example.com',
      target: 'app.example.com',
    });

    const ep = dnsEntryToEndpoint(entry, ownership);

    expect(ep.recordType).toBe('CNAME');
    expect(ep.targets).toEqual(['app.example.com']);
  });

  it('maps an MX record as "<priority> <server>"', () => {
    const entry = plainToInstance(DnsMxEntry, {
      type: DNSTypes.MX,
      name: 'example.com',
      server: 'mail.example.com',
      priority: 10,
    });

    const ep = dnsEntryToEndpoint(entry, ownership);

    expect(ep.recordType).toBe('MX');
    expect(ep.targets).toEqual(['10 mail.example.com']);
  });

  it('maps an NS record', () => {
    const entry = plainToInstance(DnsNsEntry, {
      type: DNSTypes.NS,
      name: 'example.com',
      server: 'ns1.example.com',
    });

    const ep = dnsEntryToEndpoint(entry, ownership);

    expect(ep.recordType).toBe('NS');
    expect(ep.targets).toEqual(['ns1.example.com']);
  });

  it('always sets the ownership label on the emitted endpoint', () => {
    const entry = plainToInstance(DnsaEntry, {
      type: DNSTypes.A,
      name: 'a.example.com',
      address: '10.0.0.1',
    });

    const ep = dnsEntryToEndpoint(entry, 'docker-dns-operator:office');

    expect(ep.labels).toEqual({
      [OWNER_LABEL_KEY]: 'docker-dns-operator:office',
    });
  });

  it('throws for an unsupported DNS type', () => {
    const entry = plainToInstance(DnsaEntry, {
      type: DNSTypes.Unsupported,
      name: 'x.example.com',
      address: '10.0.0.1',
    });

    expect(() => dnsEntryToEndpoint(entry, ownership)).toThrow(
      /unsupported DNS type/i,
    );
  });

  describe('cloudflare-proxied providerSpecific round-trip', () => {
    it('emits providerSpecific=true when cf.proxy=true on an A entry', () => {
      const entry = plainToInstance(DnsaEntry, {
        type: DNSTypes.A,
        name: 'app.example.com',
        address: '10.1.2.3',
        providerOptions: { cf: { proxy: true } },
      });

      const ep = dnsEntryToEndpoint(entry, ownership);

      expect(ep.providerSpecific).toEqual([
        { name: CLOUDFLARE_PROXIED_KEY, value: 'true' },
      ]);
    });

    it('emits providerSpecific=false when cf.proxy=false on a CNAME entry', () => {
      const entry = plainToInstance(DnsCnameEntry, {
        type: DNSTypes.CNAME,
        name: 'www.example.com',
        target: 'app.example.com',
        providerOptions: { cf: { proxy: false } },
      });

      const ep = dnsEntryToEndpoint(entry, ownership);

      expect(ep.providerSpecific).toEqual([
        { name: CLOUDFLARE_PROXIED_KEY, value: 'false' },
      ]);
    });

    it('omits providerSpecific when cf.proxy is unset', () => {
      const entry = plainToInstance(DnsaEntry, {
        type: DNSTypes.A,
        name: 'app.example.com',
        address: '10.1.2.3',
      });

      const ep = dnsEntryToEndpoint(entry, ownership);

      expect(ep.providerSpecific).toBeUndefined();
    });

    it('omits providerSpecific on MX records even with cf.proxy set', () => {
      const entry = plainToInstance(DnsMxEntry, {
        type: DNSTypes.MX,
        name: 'example.com',
        server: 'mail.example.com',
        priority: 10,
        providerOptions: { cf: { proxy: true } },
      });

      const ep = dnsEntryToEndpoint(entry, ownership);

      expect(ep.providerSpecific).toBeUndefined();
    });
  });
});

describe('cfProxiedFromEndpoint', () => {
  it('parses "true" to boolean true', () => {
    expect(
      cfProxiedFromEndpoint({
        dnsName: 'x',
        recordType: 'A',
        targets: ['1.2.3.4'],
        providerSpecific: [{ name: CLOUDFLARE_PROXIED_KEY, value: 'true' }],
      }),
    ).toBe(true);
  });

  it('parses "false" to boolean false', () => {
    expect(
      cfProxiedFromEndpoint({
        dnsName: 'x',
        recordType: 'A',
        targets: ['1.2.3.4'],
        providerSpecific: [{ name: CLOUDFLARE_PROXIED_KEY, value: 'false' }],
      }),
    ).toBe(false);
  });

  it('returns undefined when the property is absent', () => {
    expect(
      cfProxiedFromEndpoint({
        dnsName: 'x',
        recordType: 'A',
        targets: ['1.2.3.4'],
      }),
    ).toBeUndefined();
  });
});
