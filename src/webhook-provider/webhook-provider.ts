import { DnsbaseEntry } from '../dto/dnsbase-entry';
import { ConsoleLoggerService } from '../logger.service';
import { IDnsProvider } from '../providers/dns-provider.interface';
import { IProviderRecord } from '../providers/provider-record.interface';
import { OWNER_LABEL_KEY, dnsEntryToEndpoint } from './endpoint-mapping';
import { Endpoint } from './types';
import { WebhookClient } from './webhook-client';
import { WebhookProviderRecord } from './webhook-provider-record';

/**
 * Generic IDnsProvider that talks to any sidecar implementing the
 * external-dns webhook provider contract.
 *
 * One instance = one webhook URL. The operator registers N instances
 * under distinct names (e.g. "mikrotik-home", "mikrotik-office") and
 * the per-entry `providers: [...]` label routes records to the matching
 * named instance.
 *
 * Records are tagged with labels[owner] = ownershipLabel on every write
 * and filtered by the same key on read, so this operator instance only
 * ever sees and modifies records it created.
 *
 * createEntry / updateEntry / deleteEntry each map to a single
 * POST /records call with a one-item Changes envelope. That trades
 * per-cycle atomicity for simplicity (no buffer/flush plumbing). When
 * a backend genuinely needs cycle-level atomicity (e.g. rfc2136
 * conditional updates) we'll add a finalizeJob() hook later.
 */
export class WebhookProvider implements IDnsProvider {
  constructor(
    public readonly providerKey: string,
    private readonly client: WebhookClient,
    private readonly ownershipLabel: string,
    private readonly logger: ConsoleLoggerService,
  ) {}

  // eslint-disable-next-line class-methods-use-this
  isConfigured(): boolean {
    return true;
  }

  // eslint-disable-next-line class-methods-use-this
  initialize(): void {
    // No-op. URL was validated when the registry built this instance.
  }

  async getRecords(): Promise<IProviderRecord[]> {
    const result = await this.client.getRecords();
    if (!result.ok) {
      throw new Error(
        `WebhookProvider[${this.providerKey}] getRecords failed: ${result.message}`,
      );
    }
    const owned = result.value.filter(
      (ep) => ep.labels?.[OWNER_LABEL_KEY] === this.ownershipLabel,
    );
    this.logger.debug(
      `WebhookProvider[${this.providerKey}] getRecords: ${result.value.length} total, ${owned.length} owned`,
    );
    return owned.map((ep) => new WebhookProviderRecord(ep));
  }

  async createEntry(entry: DnsbaseEntry): Promise<void> {
    const endpoint = dnsEntryToEndpoint(entry, this.ownershipLabel);
    const result = await this.client.applyChanges({ create: [endpoint] });
    if (!result.ok) {
      throw new Error(
        `WebhookProvider[${this.providerKey}] createEntry ${endpoint.recordType} ${endpoint.dnsName}: ${result.message}`,
      );
    }
  }

  async updateEntry(
    oldRecord: IProviderRecord,
    desired: DnsbaseEntry,
  ): Promise<void> {
    const oldEndpoint = (oldRecord.providerContext as { endpoint?: Endpoint })
      .endpoint;
    if (!oldEndpoint) {
      throw new Error(
        `WebhookProvider[${this.providerKey}] updateEntry: oldRecord missing providerContext.endpoint — was it built by WebhookProvider?`,
      );
    }
    const newEndpoint = dnsEntryToEndpoint(desired, this.ownershipLabel);
    const result = await this.client.applyChanges({
      updateOld: [oldEndpoint],
      updateNew: [newEndpoint],
    });
    if (!result.ok) {
      throw new Error(
        `WebhookProvider[${this.providerKey}] updateEntry ${newEndpoint.recordType} ${newEndpoint.dnsName}: ${result.message}`,
      );
    }
  }

  async deleteEntry(oldRecord: IProviderRecord): Promise<void> {
    const oldEndpoint = (oldRecord.providerContext as { endpoint?: Endpoint })
      .endpoint;
    if (!oldEndpoint) {
      throw new Error(
        `WebhookProvider[${this.providerKey}] deleteEntry: oldRecord missing providerContext.endpoint`,
      );
    }
    const result = await this.client.applyChanges({ delete: [oldEndpoint] });
    if (!result.ok) {
      throw new Error(
        `WebhookProvider[${this.providerKey}] deleteEntry ${oldEndpoint.recordType} ${oldEndpoint.dnsName}: ${result.message}`,
      );
    }
  }
}
