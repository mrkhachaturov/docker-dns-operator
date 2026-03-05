import { MikrotikService } from './mikrotik.service';
import { ConsoleLoggerService } from '../logger.service';
import { ConfigService } from '@nestjs/config';
import { createMock, DeepMocked } from '@golevelup/ts-jest';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DNSTypes } from '../dto/dnsbase-entry';

// Polyfill fetch for tests
global.fetch = jest.fn();
const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe('MikrotikService', () => {
  let sut: MikrotikService;
  let configService: DeepMocked<ConfigService>;
  let logger: DeepMocked<ConsoleLoggerService>;

  const baseEnv = {
    MIKROTIK_BASEURL: 'https://192.168.1.1',
    MIKROTIK_USERNAME: 'admin',
    MIKROTIK_PASSWORD: 'secret',
    MIKROTIK_SKIP_TLS_VERIFY: false,
    MIKROTIK_DEFAULT_TTL: 3600,
    ENTRY_IDENTIFIER: 'project:instance',
  };

  beforeEach(() => {
    configService = createMock<ConfigService>();
    logger = createMock<ConsoleLoggerService>();
    configService.get.mockImplementation((key) => baseEnv[key as keyof typeof baseEnv]);
    sut = new MikrotikService(configService, logger);
    mockFetch.mockReset();
  });

  describe('isConfigured', () => {
    it('returns true when all three required vars are set', () => {
      expect(sut.isConfigured()).toBe(true);
    });

    it('returns false when MIKROTIK_BASEURL is missing', () => {
      configService.get.mockImplementation((key) =>
        key === 'MIKROTIK_BASEURL' ? undefined : baseEnv[key as keyof typeof baseEnv],
      );
      expect(sut.isConfigured()).toBe(false);
    });
  });

  describe('TLS verification', () => {
    it('does not set dispatcher when MIKROTIK_SKIP_TLS_VERIFY is false', () => {
      sut.initialize();
      expect((sut as any).dispatcher).toBeUndefined();
    });

    it('sets dispatcher when MIKROTIK_SKIP_TLS_VERIFY is true', () => {
      configService.get.mockImplementation((key) =>
        key === 'MIKROTIK_SKIP_TLS_VERIFY' ? true : baseEnv[key as keyof typeof baseEnv],
      );
      sut.initialize();
      expect((sut as any).dispatcher).toBeDefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('TLS verification disabled'),
      );
    });

    it('passes dispatcher to fetch when set', async () => {
      configService.get.mockImplementation((key) =>
        key === 'MIKROTIK_SKIP_TLS_VERIFY' ? true : baseEnv[key as keyof typeof baseEnv],
      );
      sut.initialize();
      mockFetch.mockResolvedValueOnce(makeJsonResponse([]));

      await sut.getRecords();

      const fetchOptions = mockFetch.mock.calls[0][1] as any;
      expect(fetchOptions.dispatcher).toBeDefined();
    });
  });

  describe('getRecords', () => {
    beforeEach(() => sut.initialize());

    it('fetches records filtered by ENTRY_IDENTIFIER comment', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse([
        { '.id': '*1', name: 'test.example.com', type: 'A', address: '1.2.3.4', comment: 'project:instance' },
      ]));

      const records = await sut.getRecords();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/ip/dns/static'),
        expect.objectContaining({ method: 'GET' }),
      );
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe('*1');
      expect(records[0].address).toBe('1.2.3.4');
    });

    it('returns empty array when no records match', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse([]));
      const records = await sut.getRecords();
      expect(records).toHaveLength(0);
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ error: 'unauthorized' }, 401));
      await expect(sut.getRecords()).rejects.toThrow('HTTP 401');
    });
  });

  describe('createEntry', () => {
    beforeEach(() => sut.initialize());

    it('creates an A record with ownership comment and default TTL', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ '.id': '*2', name: 'new.example.com' }));

      const entry = new DnsaEntry();
      entry.type = DNSTypes.A;
      entry.name = 'new.example.com';
      entry.address = '5.5.5.5';
      entry.providers = ['mikrotik'];

      await sut.createEntry(entry);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/ip/dns/static'),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"address":"5.5.5.5"'),
        }),
      );
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.comment).toBe('project:instance');
      expect(body.ttl).toBe('1h'); // 3600s default
    });
  });

  describe('updateEntry', () => {
    beforeEach(() => sut.initialize());

    it('sends PATCH to the record id endpoint', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({ '.id': '*1' }));

      const entry = new DnsaEntry();
      entry.type = DNSTypes.A;
      entry.name = 'test.example.com';
      entry.address = '9.9.9.9';

      const record = { id: '*1', providerContext: {} } as any;
      await sut.updateEntry(record, entry);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/ip/dns/static/*1'),
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  describe('deleteEntry', () => {
    beforeEach(() => sut.initialize());

    it('sends DELETE to the record id endpoint', async () => {
      mockFetch.mockResolvedValueOnce(makeJsonResponse({}));
      const record = { id: '*1', providerContext: {} } as any;

      await sut.deleteEntry(record);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/ip/dns/static/*1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });
});
