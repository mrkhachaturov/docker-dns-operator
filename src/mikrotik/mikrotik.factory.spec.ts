import { MikrotikFactory } from './mikrotik.factory';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry } from '../dto/dnsns-entry';
import { DNSTypes } from '../dto/dnsbase-entry';

describe('MikrotikFactory', () => {
  let sut: MikrotikFactory;
  const entryIdentifier = 'project:instance';
  const defaultTTLSeconds = 3600;

  beforeEach(() => {
    sut = new MikrotikFactory();
  });

  it('creates A record body', () => {
    const entry = new DnsaEntry();
    entry.type = DNSTypes.A;
    entry.name = 'host.example.com';
    entry.address = '1.2.3.4';

    const result = sut.toCreateBody(entry, entryIdentifier, defaultTTLSeconds);

    expect(result).toEqual({
      name: 'host.example.com',
      type: 'A',
      address: '1.2.3.4',
      comment: entryIdentifier,
      ttl: '1h',
    });
  });

  it('creates CNAME record body', () => {
    const entry = new DnsCnameEntry();
    entry.type = DNSTypes.CNAME;
    entry.name = 'alias.example.com';
    entry.target = 'host.example.com';

    const result = sut.toCreateBody(entry, entryIdentifier, defaultTTLSeconds);

    expect(result).toMatchObject({ cname: 'host.example.com', type: 'CNAME' });
  });

  it('creates MX record body', () => {
    const entry = new DnsMxEntry();
    entry.type = DNSTypes.MX;
    entry.name = 'mail.example.com';
    entry.server = 'mx.mail.com';
    entry.priority = 10;

    const result = sut.toCreateBody(entry, entryIdentifier, defaultTTLSeconds);

    expect(result).toMatchObject({
      'mx-exchange': 'mx.mail.com',
      'mx-preference': '10',
      type: 'MX',
    });
  });

  it('creates NS record body', () => {
    const entry = new DnsNsEntry();
    entry.type = DNSTypes.NS;
    entry.name = 'example.com';
    entry.server = 'ns1.example.com';

    const result = sut.toCreateBody(entry, entryIdentifier, defaultTTLSeconds);

    expect(result).toMatchObject({ ns: 'ns1.example.com', type: 'NS' });
  });

  it('throws for unsupported type', () => {
    const entry = new DnsaEntry();
    entry.type = 'AAAA' as any;
    expect(() =>
      sut.toCreateBody(entry, entryIdentifier, defaultTTLSeconds),
    ).toThrow();
  });

  it('toUpdateBody does not include comment or ttl', () => {
    const entry = new DnsaEntry();
    entry.type = DNSTypes.A;
    entry.name = 'host.example.com';
    entry.address = '1.2.3.4';

    const result = sut.toUpdateBody(entry);

    expect(result).not.toHaveProperty('comment');
    expect(result).not.toHaveProperty('ttl');
    expect(result).toMatchObject({ address: '1.2.3.4' });
  });
});
