/**
 * E2e tests for provider routing.
 * Verifies that DNS entries are routed to the correct provider(s) based on
 * the `providers` label field.
 *
 * After the MikroTik extraction this file no longer exercises the in-process
 * MikroTik service — that path has moved to the ddo-mikrotik sidecar. The
 * routing logic itself still lives in the operator and is unit-tested in
 * src/app.service.spec.ts. These e2e cases focus on CloudFlare (the last
 * remaining in-process provider) and on the strict-routing behaviour for
 * unknown provider keys.
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

  beforeEach(() => {
    mockCfDnsRecords.create.mockClear();
    mockCfDnsRecords.update.mockClear();
    mockCfDnsRecords.delete.mockClear();
  });

  it('entry with providers=["cf"] is synced to CloudFlare', async () => {
    const cfEntry = makeEntry('cf-only.testdomain.com', ['cf']);
    mockDockerService.getSources.mockResolvedValue([]);
    (mockDockerService.extractDNSEntries as jest.Mock).mockReturnValue([
      cfEntry,
    ]);

    await sut.job();

    expect(mockCfDnsRecords.create).toHaveBeenCalledTimes(1);
  });

  it('entry without providers field defaults to all configured providers', async () => {
    const defaultEntry = validDnsAEntry(DnsaEntry, {
      name: 'default.testdomain.com',
    });
    defaultEntry.providers = undefined;
    mockDockerService.getSources.mockResolvedValue([]);
    (mockDockerService.extractDNSEntries as jest.Mock).mockReturnValue([
      defaultEntry,
    ]);

    await sut.job();

    // The only configured provider in this test is CF — so it gets the entry.
    expect(mockCfDnsRecords.create).toHaveBeenCalledTimes(1);
  });

  it('entry with providers=["all"] is synced to every configured provider', async () => {
    const allEntry = makeEntry('all.testdomain.com', ['all']);
    mockDockerService.getSources.mockResolvedValue([]);
    (mockDockerService.extractDNSEntries as jest.Mock).mockReturnValue([
      allEntry,
    ]);

    await sut.job();

    expect(mockCfDnsRecords.create).toHaveBeenCalledTimes(1);
  });

  it('entry referencing an unknown provider is skipped (strict routing)', async () => {
    const unknownEntry = makeEntry('unknown.testdomain.com', ['mikrotik']);
    mockDockerService.getSources.mockResolvedValue([]);
    (mockDockerService.extractDNSEntries as jest.Mock).mockReturnValue([
      unknownEntry,
    ]);

    await sut.job();

    // "mikrotik" is no longer configured in-process; the entry must not
    // round-trip to CloudFlare even though that's the only configured
    // provider — strict routing rejects unknown keys outright.
    expect(mockCfDnsRecords.create).not.toHaveBeenCalled();
  });
});
