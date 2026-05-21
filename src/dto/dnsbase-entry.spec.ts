import each from 'jest-each';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DnsbaseEntry, DNSTypes } from './dnsbase-entry';
import { DnsaEntry } from './dnsa-entry';

export type DnsBaseCloudflareEntry = {
  zoneId: string;
  id: string;
  name: string;
  type: DNSTypes;
};

class MockDnsEntry extends DnsbaseEntry {
  // implemented because it's required, but not used or tested in this suite.
  // hence the reasons for the diabling comments
  //
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, class-methods-use-this
  hasSameValue(otherEntry: DnsbaseEntry): boolean {
    throw new Error('Method not implemented.');
  }
}

describe('DnsbaseEntry', () => {
  const sutName = 'testdomain.com';
  const sutType = DNSTypes.CNAME;
  let sut: DnsbaseEntry;

  beforeEach(() => {
    sut = new MockDnsEntry();
    sut.type = sutType;
    sut.name = sutName;
  });

  it('should be defined', () => {
    expect(new MockDnsEntry()).toBeDefined();
  });

  it('should return a unique identifier with colon separator', () => {
    expect(sut.Key).toEqual(`${sut.type}:${sut.name}`);
  });

  it('should have providers defaulting to undefined', () => {
    expect(sut.providers).toBeUndefined();
  });

  it('should accept providers array', () => {
    sut.providers = ['cf', 'mikrotik'];
    expect(sut.providers).toEqual(['cf', 'mikrotik']);
  });

  it('should accept providerOptions', () => {
    sut.providerOptions = { cf: { proxy: true } };
    expect(sut.providerOptions?.cf?.proxy).toBe(true);
  });

  describe('DNSTypes', () => {
    it('includes AAAA for IPv6 records', () => {
      expect(DNSTypes.AAAA).toBe('AAAA');
    });
  });

  describe('IProviderOptions.rfc2136', () => {
    it('accepts a numeric ttl', () => {
      const entry = plainToInstance(DnsaEntry, {
        type: DNSTypes.A,
        name: 'host.example.com',
        address: '10.0.0.1',
        providers: ['rfc2136'],
        providerOptions: { rfc2136: { ttl: 600 } },
      });
      expect(entry.providerOptions?.rfc2136?.ttl).toBe(600);
    });
  });

  describe('validation', () => {
    it('should be valid', async () => {
      // act ;/ ass;ert
      expect(validate(sut)).resolves.toHaveLength(0);
    });

    describe('name', () => {
      each(['test.work', 'www.test.work', 'ns1.test.work', 'mx.test.work']).it(
        'should be a valid domain name (%p)',
        async (domainName) => {
          // arrange
          sut.name = domainName;

          // act / assert
          expect(validate(sut)).resolves.toHaveLength(0);
        },
      );

      each(['a', 'em', '', '   ', '123', 'test@thing.com']).it(
        'should not be an invalid string (%p)',
        async (invalid) => {
          // arrange
          sut.name = invalid;

          // act
          const result = await validate(sut);

          // assert
          expect(result).toHaveLength(1);
          expect(result[0].property).toBe('name');
          expect(result[0].value).toBe(invalid);
        },
      );
    });

    describe('type', () => {
      each(Object.keys(DNSTypes)).it(
        'should be a valid DNS type (%p)',
        async (dnsType) => {
          // arrange
          sut.type = DNSTypes[dnsType as keyof typeof DNSTypes];

          // act / assert
          expect(validate(sut)).resolves.toHaveLength(0);
        },
      );

      each(['a', 'em', '', '   ', '123', 'test@thing.com']).it(
        'should not be an invalid string (%p)',
        async (invalid) => {
          // arrange
          sut.type = invalid;

          // act
          const result = await validate(sut);

          // assert
          expect(result).toHaveLength(1);
          expect(result[0].property).toBe('type');
          expect(result[0].value).toBe(invalid);
        },
      );
    });
  });
});
