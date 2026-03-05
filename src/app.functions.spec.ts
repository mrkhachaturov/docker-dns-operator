import { validDnsAEntry } from './dto/dnsa-entry.spec';
import { DnsaEntry } from './dto/dnsa-entry';
import { validDnsCnameEntry } from './dto/dnscname-entry.spec';
import { DnsCnameEntry } from './dto/dnscname-entry';
import { validDnsMxEntry } from './dto/dnsmx-entry.spec';
import { DnsMxEntry } from './dto/dnsmx-entry';
import { validDnsNsEntry } from './dto/dnsns-entry.spec';
import { DnsNsEntry } from './dto/dnsns-entry';
import { DNSTypes } from './dto/dnsbase-entry';
import { computeSetDifference } from './app.functions';
import { IProviderRecord } from './providers/provider-record.interface';

function makeProviderRecord(overrides: {
  id?: string;
  name: string;
  type?: DNSTypes;
  sameValue?: boolean;
  zoneId?: string;
}): IProviderRecord {
  return {
    id: overrides.id ?? 'test-id',
    name: overrides.name,
    type: overrides.type ?? DNSTypes.A,
    get Key() {
      return `${this.type}:${this.name}`;
    },
    hasSameValue: jest.fn().mockReturnValue(overrides.sameValue ?? true),
    providerContext: { zoneId: overrides.zoneId ?? 'zone-1' },
  };
}

describe('AppFunctions', () => {
  describe('computeSetDifference', () => {
    it('should compute the set difference', () => {
      // arrange
      const toDeleteUnsupported = makeProviderRecord({
        id: 'unsupported-id',
        name: 'unsupported',
        type: DNSTypes.Unsupported,
        sameValue: true,
      });

      const entriesDockerToAdd = [
        validDnsAEntry(DnsaEntry, { name: 'to-add-a' }),
        validDnsCnameEntry(DnsCnameEntry, { name: 'to-add-cname' }),
      ];
      const entriesDockerToUpdate = [
        validDnsAEntry(DnsaEntry, { name: 'to-update-a' }),
        validDnsCnameEntry(DnsCnameEntry, { name: 'to-update-cname' }),
        validDnsMxEntry(DnsMxEntry, { name: 'to-update-mx' }),
        validDnsNsEntry(DnsNsEntry, { name: 'to-update-ns' }),
      ];
      const entriesCfToUpdate = [
        makeProviderRecord({ name: 'to-update-a', sameValue: false }),
        makeProviderRecord({
          name: 'to-update-cname',
          type: DNSTypes.CNAME,
          sameValue: false,
        }),
        makeProviderRecord({
          name: 'to-update-mx',
          type: DNSTypes.MX,
          sameValue: false,
        }),
        makeProviderRecord({
          name: 'to-update-ns',
          type: DNSTypes.NS,
          sameValue: false,
        }),
      ];
      const entriesDockerUnchanged = [
        validDnsAEntry(DnsaEntry, { name: 'unchanged-a' }),
        validDnsCnameEntry(DnsCnameEntry, { name: 'unchanged-cname' }),
        validDnsMxEntry(DnsMxEntry, { name: 'unchanged-mx' }),
        validDnsNsEntry(DnsNsEntry, { name: 'unchanged-ns' }),
      ];
      const entriesCfUnchanged = [
        makeProviderRecord({
          id: 'unchanged-a-id',
          name: 'unchanged-a',
          sameValue: true,
        }),
        makeProviderRecord({
          id: 'unchanged-cname-id',
          name: 'unchanged-cname',
          type: DNSTypes.CNAME,
          sameValue: true,
        }),
        makeProviderRecord({
          id: 'unchanged-mx-id',
          name: 'unchanged-mx',
          type: DNSTypes.MX,
          sameValue: true,
        }),
        makeProviderRecord({
          id: 'unchanged-ns-id',
          name: 'unchanged-ns',
          type: DNSTypes.NS,
          sameValue: true,
        }),
      ];
      const entriesCfToDelete = [
        makeProviderRecord({
          id: 'to-delete-id',
          name: 'to-delete',
          type: DNSTypes.CNAME,
          sameValue: true,
        }),
        toDeleteUnsupported,
      ];
      // act
      const result = computeSetDifference(
        [
          ...entriesDockerToAdd,
          ...entriesDockerToUpdate,
          ...entriesDockerUnchanged,
        ],
        [...entriesCfToDelete, ...entriesCfToUpdate, ...entriesCfUnchanged],
      );

      // assert
      expect(result.add).toEqual(entriesDockerToAdd);
      expect(result.update).toEqual([
        { old: entriesCfToUpdate[0], update: entriesDockerToUpdate[0] },
        { old: entriesCfToUpdate[1], update: entriesDockerToUpdate[1] },
        { old: entriesCfToUpdate[2], update: entriesDockerToUpdate[2] },
        { old: entriesCfToUpdate[3], update: entriesDockerToUpdate[3] },
      ]);
      expect(result.delete).toEqual(entriesCfToDelete);
      expect(result.unchanged).toEqual(entriesCfUnchanged);
    });
  });

  describe('computeSetDifference (generic IProviderRecord)', () => {
    it('should compute add, update, delete, unchanged with generic provider records', () => {
      const toAdd = [validDnsAEntry(DnsaEntry, { name: 'new-entry' })];
      const toUpdateDocker = [validDnsAEntry(DnsaEntry, { name: 'update-me' })];
      const toUpdateProvider = [
        makeProviderRecord({ name: 'update-me', sameValue: false }),
      ];
      const unchangedDocker = [validDnsAEntry(DnsaEntry, { name: 'keep-me' })];
      const unchangedProvider = [
        makeProviderRecord({ name: 'keep-me', sameValue: true }),
      ];
      const toDelete = [
        makeProviderRecord({ id: 'del-id', name: 'delete-me' }),
      ];

      const result = computeSetDifference(
        [...toAdd, ...toUpdateDocker, ...unchangedDocker],
        [...toUpdateProvider, ...unchangedProvider, ...toDelete],
      );

      expect(result.add).toEqual(toAdd);
      expect(result.update).toHaveLength(1);
      expect(result.update[0].old).toBe(toUpdateProvider[0]);
      expect(result.update[0].update).toBe(toUpdateDocker[0]);
      expect(result.delete).toEqual(toDelete);
      expect(result.unchanged).toEqual(unchangedProvider);
    });
  });
});
