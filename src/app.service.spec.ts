import { Test, TestingModule } from '@nestjs/testing';
import { createMock, DeepMocked } from '@golevelup/ts-jest';
import { AppService, State } from './app.service';
import { DockerService } from './docker/docker.service';
import { ConsoleLoggerService } from './logger.service';
import { DdnsService } from './ddns/ddns.service';
import { ProviderRegistry } from './providers/provider-registry.service';
import { IDnsProvider } from './providers/dns-provider.interface';
import { DNSTypes } from './dto/dnsbase-entry';
import { DnsaEntry } from './dto/dnsa-entry';
import { validDnsAEntry } from './dto/dnsa-entry.spec';
import { CloudflareProviderRecord } from './cloud-flare/cloudflare-provider-record';

function makeMockProvider(key: string): DeepMocked<IDnsProvider> {
  return {
    providerKey: key,
    isConfigured: jest.fn().mockReturnValue(true),
    initialize: jest.fn(),
    prepareForJob: jest.fn().mockResolvedValue(undefined),
    getRecords: jest.fn().mockResolvedValue([]),
    createEntry: jest.fn().mockResolvedValue(undefined),
    updateEntry: jest.fn().mockResolvedValue(undefined),
    deleteEntry: jest.fn().mockResolvedValue(undefined),
  } as unknown as DeepMocked<IDnsProvider>;
}

function makeProviderRecord(name: string, type = DNSTypes.A): CloudflareProviderRecord {
  const r = new CloudflareProviderRecord();
  r.id = `${name}-id`;
  r.name = name;
  r.type = type;
  r.zoneId = 'zone-1';
  r.address = '1.2.3.4';
  r.proxy = false;
  return r;
}

describe('AppService', () => {
  let sut: AppService;
  let mockDockerService: DeepMocked<DockerService>;
  let mockDdnsService: DeepMocked<DdnsService>;
  let mockProviderRegistry: DeepMocked<ProviderRegistry>;
  let mockCfProvider: DeepMocked<IDnsProvider>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AppService],
    })
      .useMocker(createMock)
      .compile();

    sut = module.get<AppService>(AppService);
    mockDockerService = module.get(DockerService) as DeepMocked<DockerService>;
    mockDdnsService = module.get(DdnsService) as DeepMocked<DdnsService>;
    mockProviderRegistry = module.get(ProviderRegistry) as DeepMocked<ProviderRegistry>;

    mockCfProvider = makeMockProvider('cf');
    mockProviderRegistry.getAll.mockReturnValue([mockCfProvider]);
    mockProviderRegistry.resolve.mockReturnValue([mockCfProvider]);
    mockDdnsService.isDdnsRequired.mockReturnValue(false);
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('initialize', () => {
    it('should throw if already initialized', () => {
      sut['state'] = State.Initialized;
      expect(() => sut.initialize()).toThrow('Already initialized');
    });

    it('should initialize registry and docker service', () => {
      sut.initialize();
      expect(mockProviderRegistry.initialize).toHaveBeenCalledTimes(1);
      expect(mockDockerService.initialize).toHaveBeenCalledTimes(1);
      expect(sut['state']).toBe(State.Initialized);
    });
  });

  describe('job', () => {
    beforeEach(() => {
      sut['state'] = State.Initialized;
      mockDockerService.getContainers.mockResolvedValue([]);
      mockDockerService.extractDNSEntries.mockReturnValue([]);
    });

    it('should throw if not initialized', async () => {
      sut['state'] = State.Uninitialized;
      await expect(sut.job()).rejects.toThrow('Not initialized');
    });

    it('should call prepareForJob, getRecords, and log sync result', async () => {
      await sut.job();
      expect(mockCfProvider.prepareForJob).toHaveBeenCalledTimes(1);
      expect(mockCfProvider.getRecords).toHaveBeenCalledTimes(1);
    });

    it('should call createEntry for new entries', async () => {
      const entry = validDnsAEntry(DnsaEntry, { name: 'new.testdomain.com' });
      entry.providers = ['cf'];
      mockDockerService.extractDNSEntries.mockReturnValue([entry]);
      mockCfProvider.getRecords.mockResolvedValue([]);

      await sut.job();

      expect(mockCfProvider.createEntry).toHaveBeenCalledTimes(1);
      expect(mockCfProvider.createEntry).toHaveBeenCalledWith(entry);
    });

    it('should call deleteEntry for removed entries', async () => {
      const existingRecord = makeProviderRecord('old.testdomain.com');
      mockCfProvider.getRecords.mockResolvedValue([existingRecord]);
      mockDockerService.extractDNSEntries.mockReturnValue([]);

      await sut.job();

      expect(mockCfProvider.deleteEntry).toHaveBeenCalledTimes(1);
      expect(mockCfProvider.deleteEntry).toHaveBeenCalledWith(existingRecord);
    });

    it('should call updateEntry for changed entries', async () => {
      const entry = validDnsAEntry(DnsaEntry, { name: 'update.testdomain.com', address: '9.9.9.9' });
      entry.providers = ['cf'];
      const existingRecord = makeProviderRecord('update.testdomain.com');
      // Make hasSameValue return false — different address
      jest.spyOn(existingRecord, 'hasSameValue').mockReturnValue(false);
      mockDockerService.extractDNSEntries.mockReturnValue([entry]);
      mockCfProvider.getRecords.mockResolvedValue([existingRecord]);

      await sut.job();

      expect(mockCfProvider.updateEntry).toHaveBeenCalledTimes(1);
      expect(mockCfProvider.updateEntry).toHaveBeenCalledWith(existingRecord, entry);
    });

    it('should filter entries to only those targeting a provider', async () => {
      const cfEntry = validDnsAEntry(DnsaEntry, { name: 'cf.testdomain.com' });
      cfEntry.providers = ['cf'];
      const mikrotikEntry = validDnsAEntry(DnsaEntry, { name: 'mikrotik.testdomain.com' });
      mikrotikEntry.providers = ['mikrotik'];

      mockDockerService.extractDNSEntries.mockReturnValue([cfEntry, mikrotikEntry]);

      await sut.job();

      // cfProvider should only receive cfEntry, not mikrotikEntry
      expect(mockCfProvider.createEntry).toHaveBeenCalledWith(cfEntry);
      expect(mockCfProvider.createEntry).not.toHaveBeenCalledWith(mikrotikEntry);
    });

    it('should include "all" entries for every provider', async () => {
      const allEntry = validDnsAEntry(DnsaEntry, { name: 'all.testdomain.com' });
      allEntry.providers = ['all'];
      mockDockerService.extractDNSEntries.mockReturnValue([allEntry]);

      await sut.job();

      expect(mockCfProvider.createEntry).toHaveBeenCalledWith(allEntry);
    });

    it('should warn and skip duplicates per provider', async () => {
      const entry1 = validDnsAEntry(DnsaEntry, { name: 'dupe.testdomain.com' });
      entry1.providers = ['cf'];
      const entry2 = validDnsAEntry(DnsaEntry, { name: 'dupe.testdomain.com', address: '2.2.2.2' });
      entry2.providers = ['cf'];

      mockDockerService.extractDNSEntries.mockReturnValue([entry1, entry2]);

      const mockLogger = sut['loggerService'] as DeepMocked<ConsoleLoggerService>;

      await sut.job();

      // Both should be skipped — neither createEntry called for 'dupe.testdomain.com'
      expect(mockCfProvider.createEntry).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('duplicate key'),
      );
    });

    it('should propagate error from provider', async () => {
      (mockCfProvider.prepareForJob as jest.Mock).mockRejectedValue(new Error('provider error'));
      await expect(sut.job()).rejects.toThrow('provider error');
    });
  });
});
