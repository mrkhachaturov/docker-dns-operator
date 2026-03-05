import each from 'jest-each';
import { validate } from 'class-validator';
import { DNSTypes } from './dnsbase-entry';
import { DnsaEntry } from './dnsa-entry';

export function validDnsAEntry<T extends DnsaEntry>(
  EntryType: new () => T,
  defaults?: Partial<T> & { proxy?: boolean },
): T {
  const result = new EntryType();
  result.type = DNSTypes.A;
  result.name = defaults?.name ?? 'testdomain.com';
  result.address = defaults?.address ?? '8.8.8.8';
  result.providers = ['cf'];
  result.providerOptions = { cf: { proxy: defaults?.proxy ?? false } };
  return result;
}

describe('DnsaEntry', () => {
  let sut: DnsaEntry;

  beforeEach(() => {
    sut = validDnsAEntry(DnsaEntry);
  });

  it('should be defined', () => {
    expect(new DnsaEntry()).toBeDefined();
  });

  describe('hasSameValue', () => {
    it('should be same value when address and proxy match', () => {
      const a = validDnsAEntry(DnsaEntry);
      const b = validDnsAEntry(DnsaEntry);
      expect(a.hasSameValue(b)).toBe(true);
    });

    it('should not be same value when address differs', () => {
      const a = validDnsAEntry(DnsaEntry);
      const b = validDnsAEntry(DnsaEntry, { address: '1.1.1.1' });
      expect(a.hasSameValue(b)).toBe(false);
    });

    it('should be same value regardless of proxy (provider-neutral — proxy comparison is IProviderRecord responsibility)', () => {
      const a = validDnsAEntry(DnsaEntry, { proxy: false });
      const b = validDnsAEntry(DnsaEntry, { proxy: true });
      expect(a.hasSameValue(b)).toBe(true);
    });

    it('should have same value but different identity', () => {
      const entry = validDnsAEntry(DnsaEntry);
      const compare = validDnsAEntry(DnsaEntry);
      compare.name = `${entry.name}-1`;
      compare.type = DNSTypes.CNAME;
      expect(entry.hasSameValue(compare)).toBe(true);
      expect(entry.Key).not.toEqual(compare.Key);
    });

    each([['different.com']]).it(
      'should not have the same value when address differs (%p)',
      (address) => {
        const entry = validDnsAEntry(DnsaEntry);
        const compare = validDnsAEntry(DnsaEntry);
        compare.address = address;
        expect(entry.hasSameValue(compare)).toBe(false);
        expect(entry.Key).toEqual(compare.Key);
      },
    );
  });

  describe('validation', () => {
    describe('address', () => {
      it('should be valid - DDNS', async () => {
        sut.address = 'DDNS';
        await expect(validate(sut)).resolves.toHaveLength(0);
      });

      it('should be valid - IP', async () => {
        sut.address = '8.8.8.8';
        await expect(validate(sut)).resolves.toHaveLength(0);
      });

      it('should be invalid', async () => {
        sut.address = 'invalid';
        const result = await validate(sut);
        expect(result).toHaveLength(1);
        expect(result[0].property).toEqual('address');
        expect(result[0].value).toEqual(sut.address);
      });
    });
  });
});
