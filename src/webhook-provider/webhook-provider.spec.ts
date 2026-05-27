import { plainToInstance } from 'class-transformer';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DNSTypes } from '../dto/dnsbase-entry';
import { ConsoleLoggerService } from '../logger.service';
import { OWNER_LABEL_KEY } from './endpoint-mapping';
import { Changes, DomainFilter, Endpoint, WebhookResult } from './types';
import { WebhookProvider } from './webhook-provider';
import { WebhookProviderRecord } from './webhook-provider-record';

class FakeClient {
  // capture inputs for assertion
  applyCalls: Changes[] = [];

  getRecordsResult: WebhookResult<Endpoint[]> = {
    ok: true,
    value: [],
  };

  applyResult: WebhookResult<void> = { ok: true, value: undefined };

  negotiateResult: WebhookResult<DomainFilter> = {
    ok: true,
    value: {},
  };

  negotiateCallCount = 0;

  async getRecords(): Promise<WebhookResult<Endpoint[]>> {
    return this.getRecordsResult;
  }

  async applyChanges(c: Changes): Promise<WebhookResult<void>> {
    this.applyCalls.push(c);
    return this.applyResult;
  }

  async negotiate(): Promise<WebhookResult<DomainFilter>> {
    this.negotiateCallCount += 1;
    return this.negotiateResult;
  }
}

const stubLogger = (): ConsoleLoggerService =>
  ({
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  }) as unknown as ConsoleLoggerService;

const OWNER = 'docker-dns-operator:home';

describe('WebhookProvider', () => {
  describe('shape', () => {
    it('exposes providerKey from constructor (for named-instance routing)', () => {
      const sut = new WebhookProvider(
        'mikrotik-home',
        new FakeClient() as never,
        OWNER,
        stubLogger(),
      );
      expect(sut.providerKey).toBe('mikrotik-home');
    });

    it('isConfigured is true once instantiated (URL validated at registration)', () => {
      const sut = new WebhookProvider(
        'cf',
        new FakeClient() as never,
        OWNER,
        stubLogger(),
      );
      expect(sut.isConfigured()).toBe(true);
    });

    it('initialize is a no-op', () => {
      const sut = new WebhookProvider(
        'cf',
        new FakeClient() as never,
        OWNER,
        stubLogger(),
      );
      expect(() => sut.initialize()).not.toThrow();
    });
  });

  describe('negotiate', () => {
    it('calls the sidecar GET / once and caches the returned DomainFilter', async () => {
      const client = new FakeClient();
      client.negotiateResult = {
        ok: true,
        value: { include: ['example.com', 'internal.example.com'] },
      };
      const sut = new WebhookProvider(
        'cf',
        client as never,
        OWNER,
        stubLogger(),
      );

      await sut.negotiate();

      expect(client.negotiateCallCount).toBe(1);
      // Now domain matching should use the cached filter.
      expect(sut.matchesDomain('app.example.com')).toBe(true);
      expect(sut.matchesDomain('other.com')).toBe(false);
    });

    it('matchesDomain returns true (match-all) before negotiate has run', () => {
      // Fail-open default — a provider that hasn't negotiated yet, or whose
      // negotiate failed, must not silently drop every record. The user can
      // see the WARN in the log; the operator keeps trying to apply.
      const sut = new WebhookProvider(
        'cf',
        new FakeClient() as never,
        OWNER,
        stubLogger(),
      );
      expect(sut.matchesDomain('anything.example.com')).toBe(true);
    });

    it('on failure, logs WARN and leaves the filter unset (match-all fail-open)', async () => {
      const client = new FakeClient();
      client.negotiateResult = {
        ok: false,
        retryable: true,
        message: 'connect ECONNREFUSED 127.0.0.1:9090',
      };
      const logger = stubLogger();
      const sut = new WebhookProvider(
        'cf-down',
        client as never,
        OWNER,
        logger,
      );

      await sut.negotiate();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('cf-down'),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('ECONNREFUSED'),
      );
      // Fail-open: a record outside any zone still matches → operator will
      // still attempt to send it, sidecar will either accept (zone came up)
      // or reject (operator surfaces per-entry WARN).
      expect(sut.matchesDomain('anything.example.com')).toBe(true);
    });

    it('empty include + no exclude is "no filter" → match-all', async () => {
      const client = new FakeClient();
      client.negotiateResult = { ok: true, value: {} };
      const sut = new WebhookProvider(
        'cf',
        client as never,
        OWNER,
        stubLogger(),
      );

      await sut.negotiate();

      expect(sut.matchesDomain('anything.com')).toBe(true);
    });
  });

  describe('getRecords', () => {
    it('returns owned records mapped to WebhookProviderRecord', async () => {
      const client = new FakeClient();
      client.getRecordsResult = {
        ok: true,
        value: [
          {
            dnsName: 'a.example.com',
            recordType: 'A',
            targets: ['10.1.2.3'],
            labels: { [OWNER_LABEL_KEY]: OWNER },
          },
        ],
      };

      const sut = new WebhookProvider(
        'cf',
        client as never,
        OWNER,
        stubLogger(),
      );
      const result = await sut.getRecords();

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(WebhookProviderRecord);
      expect(result[0].name).toBe('a.example.com');
      expect(result[0].type).toBe(DNSTypes.A);
    });

    it('filters out records owned by another instance', async () => {
      const client = new FakeClient();
      client.getRecordsResult = {
        ok: true,
        value: [
          {
            dnsName: 'mine.example.com',
            recordType: 'A',
            targets: ['10.1.1.1'],
            labels: { [OWNER_LABEL_KEY]: OWNER },
          },
          {
            dnsName: 'theirs.example.com',
            recordType: 'A',
            targets: ['10.2.2.2'],
            labels: { [OWNER_LABEL_KEY]: 'someone-else:1' },
          },
          {
            dnsName: 'unlabeled.example.com',
            recordType: 'A',
            targets: ['10.3.3.3'],
            // no labels at all — pre-existing record not managed by anyone
          },
        ],
      };

      const sut = new WebhookProvider(
        'cf',
        client as never,
        OWNER,
        stubLogger(),
      );
      const result = await sut.getRecords();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('mine.example.com');
    });

    it('throws when the client returns a failure', async () => {
      const client = new FakeClient();
      client.getRecordsResult = {
        ok: false,
        retryable: true,
        status: 503,
        message: 'sidecar degraded',
      };

      const sut = new WebhookProvider(
        'cf',
        client as never,
        OWNER,
        stubLogger(),
      );
      await expect(sut.getRecords()).rejects.toThrow(/sidecar degraded/);
    });
  });

  describe('createEntry', () => {
    it('POSTs a Changes object with a single create endpoint carrying the ownership label', async () => {
      const client = new FakeClient();
      const sut = new WebhookProvider(
        'cf',
        client as never,
        OWNER,
        stubLogger(),
      );

      const entry = plainToInstance(DnsaEntry, {
        type: DNSTypes.A,
        name: 'new.example.com',
        address: '10.5.5.5',
      });
      await sut.createEntry(entry);

      expect(client.applyCalls).toHaveLength(1);
      expect(client.applyCalls[0]).toEqual({
        create: [
          {
            dnsName: 'new.example.com',
            recordType: 'A',
            targets: ['10.5.5.5'],
            labels: { [OWNER_LABEL_KEY]: OWNER },
          },
        ],
      });
    });

    it('throws when the sidecar rejects the change', async () => {
      const client = new FakeClient();
      client.applyResult = {
        ok: false,
        retryable: false,
        status: 400,
        message: 'invalid record',
      };
      const sut = new WebhookProvider(
        'cf',
        client as never,
        OWNER,
        stubLogger(),
      );

      const entry = plainToInstance(DnsaEntry, {
        type: DNSTypes.A,
        name: 'bad.example.com',
        address: '10.5.5.5',
      });
      await expect(sut.createEntry(entry)).rejects.toThrow(/invalid record/);
    });
  });

  describe('updateEntry', () => {
    it('POSTs a paired updateOld/updateNew with the old endpoint from providerContext', async () => {
      const client = new FakeClient();
      const oldEndpoint: Endpoint = {
        dnsName: 'app.example.com',
        recordType: 'A',
        targets: ['10.0.0.1'],
        labels: { [OWNER_LABEL_KEY]: OWNER },
      };
      const oldRecord = new WebhookProviderRecord(oldEndpoint);

      const desired = plainToInstance(DnsaEntry, {
        type: DNSTypes.A,
        name: 'app.example.com',
        address: '10.0.0.99',
      });

      const sut = new WebhookProvider(
        'cf',
        client as never,
        OWNER,
        stubLogger(),
      );
      await sut.updateEntry(oldRecord, desired);

      expect(client.applyCalls).toHaveLength(1);
      expect(client.applyCalls[0]).toEqual({
        updateOld: [oldEndpoint],
        updateNew: [
          {
            dnsName: 'app.example.com',
            recordType: 'A',
            targets: ['10.0.0.99'],
            labels: { [OWNER_LABEL_KEY]: OWNER },
          },
        ],
      });
    });
  });

  describe('deleteEntry', () => {
    it('POSTs a delete with the old endpoint from providerContext', async () => {
      const client = new FakeClient();
      const oldEndpoint: Endpoint = {
        dnsName: 'gone.example.com',
        recordType: 'CNAME',
        targets: ['old.example.com'],
        labels: { [OWNER_LABEL_KEY]: OWNER },
      };
      const oldRecord = new WebhookProviderRecord(oldEndpoint);

      const sut = new WebhookProvider(
        'cf',
        client as never,
        OWNER,
        stubLogger(),
      );
      await sut.deleteEntry(oldRecord);

      expect(client.applyCalls).toHaveLength(1);
      expect(client.applyCalls[0]).toEqual({ delete: [oldEndpoint] });
    });

    it('throws on sidecar failure', async () => {
      const client = new FakeClient();
      client.applyResult = {
        ok: false,
        retryable: true,
        status: 500,
        message: 'backend timeout',
      };
      const oldRecord = new WebhookProviderRecord({
        dnsName: 'gone.example.com',
        recordType: 'A',
        targets: ['10.0.0.5'],
        labels: { [OWNER_LABEL_KEY]: OWNER },
      });

      const sut = new WebhookProvider(
        'cf',
        client as never,
        OWNER,
        stubLogger(),
      );
      await expect(sut.deleteEntry(oldRecord)).rejects.toThrow(
        /backend timeout/,
      );
    });
  });

  describe('updateEntry — non-WebhookProviderRecord input', () => {
    it('throws if oldRecord has no endpoint in providerContext', async () => {
      const client = new FakeClient();
      const desired = plainToInstance(DnsCnameEntry, {
        type: DNSTypes.CNAME,
        name: 'x.example.com',
        target: 'y.example.com',
      });
      const sut = new WebhookProvider(
        'cf',
        client as never,
        OWNER,
        stubLogger(),
      );

      const bogusOld = {
        id: 'X',
        name: 'x.example.com',
        type: DNSTypes.CNAME,
        Key: 'CNAME:x.example.com',
        providerContext: {}, // missing endpoint
        hasSameValue: () => false,
      };

      await expect(sut.updateEntry(bogusOld as never, desired)).rejects.toThrow(
        /providerContext.endpoint/,
      );
    });
  });
});
