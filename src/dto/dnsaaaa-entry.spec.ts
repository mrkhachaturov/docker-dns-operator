import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DnsAaaaEntry } from './dnsaaaa-entry';
import { DNSTypes } from './dnsbase-entry';

describe('DnsAaaaEntry', () => {
  it('accepts a valid IPv6 address', async () => {
    const entry = plainToInstance(DnsAaaaEntry, {
      type: DNSTypes.AAAA,
      name: 'host.example.com',
      address: '2001:db8::1',
    });
    const errors = await validate(entry);
    expect(errors).toEqual([]);
  });

  it('rejects an IPv4 address', async () => {
    const entry = plainToInstance(DnsAaaaEntry, {
      type: DNSTypes.AAAA,
      name: 'host.example.com',
      address: '10.0.0.1',
    });
    const errors = await validate(entry);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty('isIp');
  });

  it('rejects a malformed address', async () => {
    const entry = plainToInstance(DnsAaaaEntry, {
      type: DNSTypes.AAAA,
      name: 'host.example.com',
      address: 'not-an-address',
    });
    const errors = await validate(entry);
    expect(errors.length).toBeGreaterThan(0);
  });
});
