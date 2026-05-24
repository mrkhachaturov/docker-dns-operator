import { plainToInstance } from 'class-transformer';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsAaaaEntry } from '../dto/dnsaaaa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry } from '../dto/dnsns-entry';
import { DNSTypes } from '../dto/dnsbase-entry';
import { OWNER_LABEL_KEY, dnsEntryToEndpoint } from './endpoint-mapping';

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
});
