import { validDnsCnameEntry } from '../src/dto/dnscname-entry.spec';
import { validDnsMxEntry } from '../src/dto/dnsmx-entry.spec';
import { validDnsNsEntry } from '../src/dto/dnsns-entry.spec';
import { DnsCnameEntry } from '../src/dto/dnscname-entry';
import { DnsMxEntry } from '../src/dto/dnsmx-entry';
import { DnsNsEntry } from '../src/dto/dnsns-entry';
import { validDnsAEntry } from '../src/dto/dnsa-entry.spec';
import { DnsaEntry, isDnsAEntry } from '../src/dto/dnsa-entry';
import { DnsbaseEntry } from '../src/dto/dnsbase-entry';
import { isDnsCnameEntry } from '../src/dto/dnscname-entry';
import { isDnsMxEntry } from '../src/dto/dnsmx-entry';
import { isDnsNsEntry } from '../src/dto/dnsns-entry';
import { CloudflareProviderRecord } from '../src/cloud-flare/cloudflare-provider-record';
import { computeSetDifference } from '../src/app.functions';

/** Build a CloudflareProviderRecord from a DnsbaseEntry for test purposes. */
function toCFRecord(entry: DnsbaseEntry, zoneId = 'zone-1', id = 'test-id'): CloudflareProviderRecord {
  const r = new CloudflareProviderRecord();
  r.id = id;
  r.name = entry.name;
  r.type = entry.type;
  r.zoneId = zoneId;
  if (isDnsAEntry(entry)) {
    r.address = entry.address;
    r.proxy = entry.providerOptions?.cf?.proxy ?? false;
  } else if (isDnsCnameEntry(entry)) {
    r.target = entry.target;
    r.proxy = entry.providerOptions?.cf?.proxy ?? false;
  } else if (isDnsMxEntry(entry)) {
    r.server = entry.server;
    r.priority = entry.priority;
  } else if (isDnsNsEntry(entry)) {
    r.server = entry.server;
  }
  return r;
}

describe('AppFunctions (Integration)', () => {
  describe('computeSetDifference', () => {
    it('should compute set difference', () => {
      // arrange
      const toAdd = [validDnsAEntry(DnsaEntry, { name: 'to-add' })];

      const toUpdateDocker = [
        validDnsAEntry(DnsaEntry, {
          name: 'to-update',
          address: 'updated-address',
        }),
        validDnsCnameEntry(DnsCnameEntry, {
          name: 'to-update',
          target: 'updated-target',
          proxy: true,
        }),
        validDnsMxEntry(DnsMxEntry, {
          name: 'to-update',
          server: 'updated-server',
          priority: 99,
        }),
        validDnsNsEntry(DnsNsEntry, {
          name: 'to-update',
          server: 'updated-server',
        }),
      ];

      const toUpdateCloudFlare = [
        toCFRecord(validDnsAEntry(DnsaEntry, { name: 'to-update' }), 'zone-1', 'to-update-id'),
        toCFRecord(validDnsCnameEntry(DnsCnameEntry, { name: 'to-update' }), 'zone-1', 'to-update-id'),
        toCFRecord(validDnsMxEntry(DnsMxEntry, { name: 'to-update' }), 'zone-1', 'to-update-id'),
        toCFRecord(validDnsNsEntry(DnsNsEntry, { name: 'to-update' }), 'zone-1', 'to-update-id'),
      ];

      const unchangedDocker = [
        validDnsAEntry(DnsaEntry, { name: 'unchanged' }),
        validDnsCnameEntry(DnsCnameEntry, { name: 'unchanged' }),
        validDnsMxEntry(DnsMxEntry, { name: 'unchanged' }),
        validDnsNsEntry(DnsNsEntry, { name: 'unchanged' }),
      ];

      const unchangedCloudFlare = [
        toCFRecord(validDnsAEntry(DnsaEntry, { name: 'unchanged' })),
        toCFRecord(validDnsCnameEntry(DnsCnameEntry, { name: 'unchanged' })),
        toCFRecord(validDnsMxEntry(DnsMxEntry, { name: 'unchanged' })),
        toCFRecord(validDnsNsEntry(DnsNsEntry, { name: 'unchanged' })),
      ];

      const toDelete = [
        toCFRecord(validDnsAEntry(DnsaEntry, { name: 'to-delete' }), 'zone-1', 'to-delete-id'),
      ];

      // act / assert
      expect(
        computeSetDifference(
          [...toAdd, ...toUpdateDocker, ...unchangedDocker],
          [...toUpdateCloudFlare, ...unchangedCloudFlare, ...toDelete],
        ),
      ).toEqual({
        unchanged: unchangedCloudFlare,
        add: toAdd,
        delete: toDelete,
        update: [
          { old: toUpdateCloudFlare[0], update: toUpdateDocker[0] },
          { old: toUpdateCloudFlare[1], update: toUpdateDocker[1] },
          { old: toUpdateCloudFlare[2], update: toUpdateDocker[2] },
          { old: toUpdateCloudFlare[3], update: toUpdateDocker[3] },
        ],
      });
    });
  });
});
