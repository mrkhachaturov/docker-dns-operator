import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// undici ships with Node >= 18 and is the engine behind native fetch in Node >= 22.
// No additional npm dependency required. Use Agent to control TLS verification.
import { Agent } from 'undici';
import { IDnsProvider } from '../providers/dns-provider.interface';
import { IProviderRecord } from '../providers/provider-record.interface';
import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { MikrotikProviderRecord } from './mikrotik-provider-record';
import { MikrotikFactory } from './mikrotik.factory';
import { ConsoleLoggerService } from '../logger.service';
import { NestedError } from '../errors/nested-error';

@Injectable()
export class MikrotikService implements IDnsProvider {
  readonly providerKey = 'mikrotik';

  private baseUrl: string;
  private username: string;
  private password: string;
  private defaultTTL: number;
  private entryIdentifier: string;
  private authHeader: string;
  /**
   * undici dispatcher. When MIKROTIK_SKIP_TLS_VERIFY=true, created with
   * rejectUnauthorized:false. Otherwise undefined (uses Node default).
   * Native fetch in Node 22 accepts a `dispatcher` option (undici extension).
   */
  private dispatcher?: Agent;

  constructor(
    private configService: ConfigService,
    private loggerService: ConsoleLoggerService,
    private factory: MikrotikFactory = new MikrotikFactory(),
  ) {}

  isConfigured(): boolean {
    return !!(
      this.configService.get('MIKROTIK_BASEURL') &&
      this.configService.get('MIKROTIK_USERNAME') &&
      this.configService.get('MIKROTIK_PASSWORD')
    );
  }

  initialize(): void {
    this.baseUrl = this.configService.get<string>('MIKROTIK_BASEURL', { infer: true })!;
    this.username = this.configService.get<string>('MIKROTIK_USERNAME', { infer: true })!;
    const password = this.configService.get<string>('MIKROTIK_PASSWORD', { infer: true })!;
    const skipTLSVerify = this.configService.get<boolean>('MIKROTIK_SKIP_TLS_VERIFY', { infer: true }) ?? false;
    this.defaultTTL = this.configService.get<number>('MIKROTIK_DEFAULT_TTL', { infer: true }) ?? 3600;
    this.entryIdentifier = this.configService.get<string>('ENTRY_IDENTIFIER', { infer: true })!;
    this.authHeader = 'Basic ' + Buffer.from(`${this.username}:${password}`).toString('base64');
    if (skipTLSVerify) {
      this.loggerService.warn('MikrotikService: TLS verification disabled (MIKROTIK_SKIP_TLS_VERIFY=true)');
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  async getRecords(): Promise<MikrotikProviderRecord[]> {
    const url = `${this.baseUrl}/rest/ip/dns/static?comment=${encodeURIComponent(this.entryIdentifier)}`;
    const raw = await this.doRequest<any[]>('GET', url);
    return raw.map((r) => this.mapRecord(r));
  }

  async createEntry(entry: DnsbaseEntry): Promise<void> {
    const body = this.factory.toCreateBody(entry, this.entryIdentifier, this.defaultTTL);
    await this.doRequest('PUT', `${this.baseUrl}/rest/ip/dns/static`, body);
  }

  async updateEntry(oldRecord: IProviderRecord, desired: DnsbaseEntry): Promise<void> {
    const body = this.factory.toUpdateBody(desired);
    await this.doRequest('PATCH', `${this.baseUrl}/rest/ip/dns/static/${oldRecord.id}`, body);
  }

  async deleteEntry(oldRecord: IProviderRecord): Promise<void> {
    await this.doRequest('DELETE', `${this.baseUrl}/rest/ip/dns/static/${oldRecord.id}`);
  }

  private mapRecord(raw: Record<string, unknown>): MikrotikProviderRecord {
    const r = new MikrotikProviderRecord();
    r.id = raw['.id'] as string;
    r.name = raw.name as string;
    r.type = (raw.type as DNSTypes) ?? DNSTypes.A;
    r.comment = raw.comment as string;
    r.ttl = raw.ttl as string | undefined;
    r.address = raw.address as string | undefined;
    r.cname = raw.cname as string | undefined;
    r.server = (raw['mx-exchange'] ?? raw.ns) as string | undefined;
    r.priority = raw['mx-preference'] ? Number(raw['mx-preference']) : undefined;
    return r;
  }

  private async doRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new NestedError(
        `MikrotikService, ${method} ${url}: HTTP ${response.status}`,
        new Error(text),
      );
    }
    if (method === 'DELETE') return undefined as T;
    return response.json() as Promise<T>;
  }
}
