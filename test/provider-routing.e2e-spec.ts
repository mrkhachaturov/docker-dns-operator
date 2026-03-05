/**
 * E2e tests for provider routing.
 * Verifies that DNS entries are routed to the correct provider(s) based on
 * the `providers` label field.
 *
 * Uses mocked DockerService (no containers needed) and mocked CloudFlare/MikroTik.
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Cloudflare from 'cloudflare';
import { createMock, DeepMocked } from '@golevelup/ts-jest';
import {
  Zone,
  ZonesV4PagePaginationArray,
} from 'cloudflare/resources/zones/zones';
import { RecordsV4PagePaginationArray } from 'cloudflare/resources/dns/records';
import { AppModule } from '../src/app.module';
import { AppService } from '../src/app.service';
import { DockerService } from '../src/docker/docker.service';
import { getConfigModuleImport } from '../src/app.configuration';
import { DnsaEntry } from '../src/dto/dnsa-entry';
import { validDnsAEntry } from '../src/dto/dnsa-entry.spec';

jest.mock('cloudflare');
const mockCloudflare = Cloudflare as jest.MockedClass<typeof Cloudflare>;

// Mock global fetch for MikroTik REST API
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

function makeEntry(name: string, providers: string[]): DnsaEntry {
  const e = validDnsAEntry(DnsaEntry, { name });
  e.providers = providers;
  return e;
}

describe('AppService — provider routing (e2e)', () => {
  let app: INestApplication;
  let sut: AppService;
  let mockDockerService: DeepMocked<DockerService>;
  let mockCfDnsRecords: jest.Mocked<Cloudflare['dns']['records']>;

  beforeAll(async () => {
    // Set MikroTik env vars so MikrotikService.isConfigured() returns true
    process.env.MIKROTIK_BASEURL = 'https://192.168.1.1';
    process.env.MIKROTIK_USERNAME = 'admin';
    process.env.MIKROTIK_PASSWORD = 'secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        {
          module: AppModule,
          imports: [getConfigModuleImport()],
        },
      ],
    })
      .overrideProvider(DockerService)
      .useValue(createMock<DockerService>())
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    sut = app.get(AppService);
    mockDockerService = app.get(DockerService) as DeepMocked<DockerService>;

    // initialize() calls CloudFlareService.initialize() → new Cloudflare()
    sut.initialize();

    // Capture CF mock instance (created inside CloudFlareService.initialize())
    const mockCloudflareInstance = mockCloudflare.mock
      .instances[0] as jest.Mocked<Cloudflare>;

    const emptyRecordsPage = {
      hasNextPage: jest.fn(() => false),
      getNextPage: jest.fn(),
      getPaginatedItems: jest.fn(() => []),
    } as unknown as RecordsV4PagePaginationArray;
    const mockZonePage = {
      hasNextPage: jest.fn(() => false),
      getNextPage: jest.fn(),
      getPaginatedItems: jest.fn(() => [
        { id: 'zone-1', name: 'testdomain.com' } as Zone,
      ]),
    } as unknown as ZonesV4PagePaginationArray;

    const mockZones = createMock<Cloudflare.Zones>();
    mockZones.list.mockResolvedValue(mockZonePage);
    mockCloudflareInstance.zones = mockZones;

    mockCfDnsRecords = createMock<Cloudflare['dns']['records']>();
    mockCfDnsRecords.list.mockResolvedValue(emptyRecordsPage);
    mockCfDnsRecords.create.mockResolvedValue({} as any);
    const mockCfDns = createMock<Cloudflare['dns']>();
    mockCfDns.records = mockCfDnsRecords;
    mockCloudflareInstance.dns = mockCfDns;
  });

  afterAll(() => {
    delete process.env.MIKROTIK_BASEURL;
    delete process.env.MIKROTIK_USERNAME;
    delete process.env.MIKROTIK_PASSWORD;
  });

  beforeEach(() => {
    mockCfDnsRecords.create.mockClear();
    mockCfDnsRecords.update.mockClear();
    mockCfDnsRecords.delete.mockClear();
    mockFetch.mockReset();
    // MikroTik: getRecords returns [], createEntry returns success
    mockFetch.mockResolvedValue(makeJsonResponse([]));
  });

  it('entry with providers=["cf"] is only synced to CloudFlare', async () => {
    const cfEntry = makeEntry('cf-only.testdomain.com', ['cf']);
    mockDockerService.getContainers.mockResolvedValue([]);
    (mockDockerService.extractDNSEntries as jest.Mock).mockReturnValue([
      cfEntry,
    ]);

    await sut.job();

    // CF should have created the entry
    expect(mockCfDnsRecords.create).toHaveBeenCalledTimes(1);
    // MikroTik fetch should only be for getRecords (not create)
    const putCalls = (mockFetch.mock.calls as any[]).filter(
      ([, opts]) => opts?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);
  });

  it('entry with providers=["mikrotik"] is only synced to MikroTik', async () => {
    const mtEntry = makeEntry('mikrotik-only.testdomain.com', ['mikrotik']);
    mockDockerService.getContainers.mockResolvedValue([]);
    (mockDockerService.extractDNSEntries as jest.Mock).mockReturnValue([
      mtEntry,
    ]);
    // MikroTik: getRecords then createEntry
    mockFetch
      .mockResolvedValueOnce(makeJsonResponse([])) // getRecords
      .mockResolvedValueOnce(makeJsonResponse({ '.id': '*1' })); // createEntry

    await sut.job();

    // CF should NOT create anything
    expect(mockCfDnsRecords.create).not.toHaveBeenCalled();
    // MikroTik fetch should have a PUT call
    const putCalls = (mockFetch.mock.calls as any[]).filter(
      ([, opts]) => opts?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0][1].body).toContain('mikrotik-only.testdomain.com');
  });

  it('entry with providers=["cf","mikrotik"] is synced to both', async () => {
    const bothEntry = makeEntry('both.testdomain.com', ['cf', 'mikrotik']);
    mockDockerService.getContainers.mockResolvedValue([]);
    (mockDockerService.extractDNSEntries as jest.Mock).mockReturnValue([
      bothEntry,
    ]);
    mockFetch
      .mockResolvedValueOnce(makeJsonResponse([])) // getRecords
      .mockResolvedValueOnce(makeJsonResponse({ '.id': '*1' })); // createEntry

    await sut.job();

    expect(mockCfDnsRecords.create).toHaveBeenCalledTimes(1);
    const putCalls = (mockFetch.mock.calls as any[]).filter(
      ([, opts]) => opts?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(1);
  });

  it('entry without providers field defaults to CF only (backward compat)', async () => {
    const defaultEntry = validDnsAEntry(DnsaEntry, {
      name: 'default.testdomain.com',
    });
    defaultEntry.providers = undefined;
    mockDockerService.getContainers.mockResolvedValue([]);
    (mockDockerService.extractDNSEntries as jest.Mock).mockReturnValue([
      defaultEntry,
    ]);

    await sut.job();

    expect(mockCfDnsRecords.create).toHaveBeenCalledTimes(1);
    const putCalls = (mockFetch.mock.calls as any[]).filter(
      ([, opts]) => opts?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);
  });

  it('entry with providers=["all"] is synced to both CF and MikroTik', async () => {
    const allEntry = makeEntry('all.testdomain.com', ['all']);
    mockDockerService.getContainers.mockResolvedValue([]);
    (mockDockerService.extractDNSEntries as jest.Mock).mockReturnValue([
      allEntry,
    ]);
    mockFetch
      .mockResolvedValueOnce(makeJsonResponse([])) // getRecords
      .mockResolvedValueOnce(makeJsonResponse({ '.id': '*1' })); // createEntry

    await sut.job();

    expect(mockCfDnsRecords.create).toHaveBeenCalledTimes(1);
    const putCalls = (mockFetch.mock.calls as any[]).filter(
      ([, opts]) => opts?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(1);
  });
});
