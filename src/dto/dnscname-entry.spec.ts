import each from 'jest-each';
import { validate } from 'class-validator';
import { DNSTypes } from './dnsbase-entry';
import { DnsCnameEntry } from './dnscname-entry';

export function validDnsCnameEntry<T extends DnsCnameEntry>(
  EntryType: new () => T,
  defaults?: Partial<T> & { proxy?: boolean },
): T {
  const result = new EntryType();
  result.type = DNSTypes.CNAME;
  result.name = defaults?.name ?? 'test.testdomain.com';
  result.target = defaults?.target ?? 'testdomain.com';
  result.providers = ['cf'];
  result.providerOptions = { cf: { proxy: defaults?.proxy ?? false } };
  return result;
}

describe('DnsCnameEntry', () => {
  let sut: DnsCnameEntry;

  beforeEach(() => {
    sut = validDnsCnameEntry(DnsCnameEntry);
  });

  it('should be defined', () => {
    expect(new DnsCnameEntry()).toBeDefined();
  });

  describe('hasSameValue', () => {
    it('should be same value when target and proxy match', () => {
      const a = validDnsCnameEntry(DnsCnameEntry);
      const b = validDnsCnameEntry(DnsCnameEntry);
      expect(a.hasSameValue(b)).toBe(true);
    });

    it('should not be same value when target differs', () => {
      const a = validDnsCnameEntry(DnsCnameEntry);
      const b = validDnsCnameEntry(DnsCnameEntry, { target: 'other.com' });
      expect(a.hasSameValue(b)).toBe(false);
    });

    it('should be same value regardless of proxy (provider-neutral)', () => {
      const a = validDnsCnameEntry(DnsCnameEntry, { proxy: false });
      const b = validDnsCnameEntry(DnsCnameEntry, { proxy: true });
      expect(a.hasSameValue(b)).toBe(true);
    });

    it('should have same value but different identity', () => {
      const entry = validDnsCnameEntry(DnsCnameEntry);
      const compare = validDnsCnameEntry(DnsCnameEntry);
      compare.name = `${entry.name}-1`;
      compare.type = DNSTypes.A;
      expect(entry.hasSameValue(compare)).toBe(true);
      expect(entry.Key).not.toEqual(compare.Key);
    });

    each([['different.com']]).it(
      'should not have the same value when target differs (%p)',
      (target) => {
        const entry = validDnsCnameEntry(DnsCnameEntry);
        const compare = validDnsCnameEntry(DnsCnameEntry);
        compare.target = target;
        expect(entry.hasSameValue(compare)).toBe(false);
        expect(entry.Key).toEqual(compare.Key);
      },
    );
  });

  describe('validation', () => {
    it('should be valid', async () => {
      expect(validate(sut)).resolves.toHaveLength(0);
    });

    describe('target', () => {
      each(['test.work', 'www.test.work', 'ns1.test.work', 'mx.test.work']).it(
        'should be a valid domain name (%p)',
        async (domainName) => {
          sut.target = domainName;
          expect(validate(sut)).resolves.toHaveLength(0);
        },
      );

      each(['a', 'em', '', '   ', '123', 'test@thing.com']).it(
        'should not be an invalid string (%p)',
        async (invalid) => {
          sut.target = invalid;
          const result = await validate(sut);
          expect(result).toHaveLength(1);
          expect(result[0].property).toBe('target');
          expect(result[0].value).toBe(invalid);
        },
      );
    });
  });
});
