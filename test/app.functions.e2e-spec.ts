import { validDnsCnameEntry } from '../src/dto/dnscname-entry.spec';
import { validDnsMxEntry } from '../src/dto/dnsmx-entry.spec';
import { validDnsNsEntry } from '../src/dto/dnsns-entry.spec';
import { DnsCnameEntry } from '../src/dto/dnscname-entry';
import { DnsMxEntry } from '../src/dto/dnsmx-entry';
import { DnsNsEntry } from '../src/dto/dnsns-entry';
import { validDnsAEntry } from '../src/dto/dnsa-entry.spec';
import { DnsaEntry } from '../src/dto/dnsa-entry';
import { DnsbaseEntry } from '../src/dto/dnsbase-entry';
import { WebhookProviderRecord } from '../src/webhook-provider/webhook-provider-record';
import { dnsEntryToEndpoint } from '../src/webhook-provider/endpoint-mapping';
import { computeSetDifference } from '../src/app.functions';

/**
 * Build a WebhookProviderRecord from a DnsbaseEntry for test purposes.
 * Uses the generic webhook contract — same shape any sidecar emits.
 */
function toWebhookRecord(entry: DnsbaseEntry): WebhookProviderRecord {
  return new WebhookProviderRecord(
    dnsEntryToEndpoint(entry, 'docker-dns-operator:1'),
  );
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

      const toUpdateWebhook = [
        toWebhookRecord(validDnsAEntry(DnsaEntry, { name: 'to-update' })),
        toWebhookRecord(
          validDnsCnameEntry(DnsCnameEntry, { name: 'to-update' }),
        ),
        toWebhookRecord(validDnsMxEntry(DnsMxEntry, { name: 'to-update' })),
        toWebhookRecord(validDnsNsEntry(DnsNsEntry, { name: 'to-update' })),
      ];

      const unchangedDocker = [
        validDnsAEntry(DnsaEntry, { name: 'unchanged' }),
        validDnsCnameEntry(DnsCnameEntry, { name: 'unchanged' }),
        validDnsMxEntry(DnsMxEntry, { name: 'unchanged' }),
        validDnsNsEntry(DnsNsEntry, { name: 'unchanged' }),
      ];

      const unchangedWebhook = [
        toWebhookRecord(validDnsAEntry(DnsaEntry, { name: 'unchanged' })),
        toWebhookRecord(
          validDnsCnameEntry(DnsCnameEntry, { name: 'unchanged' }),
        ),
        toWebhookRecord(validDnsMxEntry(DnsMxEntry, { name: 'unchanged' })),
        toWebhookRecord(validDnsNsEntry(DnsNsEntry, { name: 'unchanged' })),
      ];

      const toDelete = [
        toWebhookRecord(validDnsAEntry(DnsaEntry, { name: 'to-delete' })),
      ];

      // act / assert
      expect(
        computeSetDifference(
          [...toAdd, ...toUpdateDocker, ...unchangedDocker],
          [...toUpdateWebhook, ...unchangedWebhook, ...toDelete],
        ),
      ).toEqual({
        unchanged: unchangedWebhook,
        add: toAdd,
        delete: toDelete,
        update: [
          { old: toUpdateWebhook[0], update: toUpdateDocker[0] },
          { old: toUpdateWebhook[1], update: toUpdateDocker[1] },
          { old: toUpdateWebhook[2], update: toUpdateDocker[2] },
          { old: toUpdateWebhook[3], update: toUpdateDocker[3] },
        ],
      });
    });
  });
});
