import { Test, TestingModule } from '@nestjs/testing';
import { createMock, DeepMocked } from '@golevelup/ts-jest';
import { ContainerInfo } from 'dockerode';
import { ConfigService } from '@nestjs/config';
import { AppService, State } from './app.service';
import { DockerService } from './docker/docker.service';
import { CloudFlareService } from './cloud-flare/cloud-flare.service';
import { DnsbaseEntry, DNSTypes } from './dto/dnsbase-entry';
import { IProviderRecord } from './providers/provider-record.interface';
import { SetDifference, computeSetDifference } from './app.functions';
import { isDnsAEntry } from './dto/dnsa-entry';
import { ConsoleLoggerService } from './logger.service';
import { DdnsService } from './ddns/ddns.service';
import { State as CronState } from './cron/cron.service';
import { CloudflareProviderRecord } from './cloud-flare/cloudflare-provider-record';

jest.mock('./app.functions');
jest.mock('./dto/dnsa-entry', () => {
  const actual = jest.requireActual('./dto/dnsa-entry');
  return { ...actual, isDnsAEntry: jest.fn() };
});

const mockAppFunctionsComputeSetDifference =
  computeSetDifference as jest.MockedFunction<typeof computeSetDifference>;
const mockIsDnsAEntry = isDnsAEntry as jest.MockedFunction<typeof isDnsAEntry>;

function makeProviderRecord(overrides: { id: string; name: string }): CloudflareProviderRecord {
  const r = new CloudflareProviderRecord();
  r.id = overrides.id;
  r.name = overrides.name;
  r.type = DNSTypes.A;
  r.zoneId = 'zone-1';
  return r;
}

describe('AppService', () => {
  let sut: AppService;
  let mockDockerService: DeepMocked<DockerService>;
  const mockDockerServiceGetContainersValues = [
    'container-1',
    'container-2',
  ] as unknown as ContainerInfo[];

  const mockDockerServiceExtractDNSEntriesValues = [
    { name: 'extracted-docker-entry-1', address: 'not-ddns', type: DNSTypes.A },
    { name: 'extracted-docker-entry-2', type: DNSTypes.CNAME },
  ] as unknown as DnsbaseEntry[];

  const mockCloudFlareRecords = [
    makeProviderRecord({ id: 'cf-rec-1', name: 'cf-entry-1' }),
    makeProviderRecord({ id: 'cf-rec-2', name: 'cf-entry-2' }),
  ];

  const mockAppFunctionsComputeSetDifferenceValue: SetDifference = {
    add: [
      { name: 'add-1-a', type: DNSTypes.A },
      { name: 'add-2-cname', type: DNSTypes.CNAME },
      { name: 'add-3-mx', type: DNSTypes.MX },
      { name: 'add-4-ns', type: DNSTypes.NS },
      { name: 'unsuccessful-1', type: DNSTypes.CNAME },
    ] as unknown as DnsbaseEntry[],
    update: [
      {
        old: makeProviderRecord({ id: 'record-id-1', name: 'updated-1-a' }),
        update: { name: 'updated-1-a', type: DNSTypes.A } as unknown as DnsbaseEntry,
      },
      {
        old: makeProviderRecord({ id: 'record-id-2', name: 'updated-2-cname' }),
        update: { name: 'updated-2-cname', type: DNSTypes.CNAME } as unknown as DnsbaseEntry,
      },
      {
        old: makeProviderRecord({ id: 'record-id-3', name: 'updated-3-mx' }),
        update: { name: 'updated-3-mx', type: DNSTypes.MX } as unknown as DnsbaseEntry,
      },
      {
        old: makeProviderRecord({ id: 'record-id-4', name: 'updated-4-ns' }),
        update: { name: 'updated-4-ns', type: DNSTypes.NS } as unknown as DnsbaseEntry,
      },
    ],
    delete: [
      makeProviderRecord({ id: 'delete-1', name: 'delete-1' }),
      makeProviderRecord({ id: 'delete-2', name: 'delete-2' }),
    ],
    unchanged: [makeProviderRecord({ id: 'unchanged-1', name: 'unchanged-1' })],
  };

  let mockCloudFlareService: DeepMocked<CloudFlareService>;
  let mockConsoleLoggerService: DeepMocked<ConsoleLoggerService>;
  const envExecutionFrequencySeconds = 999;
  let mockConfigService: DeepMocked<ConfigService>;
  const mockConfigServiceGetValue = {
    EXECUTION_FREQUENCY_SECONDS: envExecutionFrequencySeconds,
  };
  let mockDdnsService: DeepMocked<DdnsService>;
  let mockDdnsServiceIsDdnsRequiredValue = false;
  const mockDdnsServiceGetIPAddressValue = 'ddns-service-ip-address';
  let mockDdnsServiceGetStateValue = CronState.Stopped;

  beforeAll(() => {
    mockAppFunctionsComputeSetDifference.mockReturnValue(
      mockAppFunctionsComputeSetDifferenceValue,
    );
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AppService],
    })
      .useMocker(createMock)
      .compile();

    mockDockerService = module.get(DockerService);
    mockDockerService.getContainers.mockResolvedValue(
      mockDockerServiceGetContainersValues,
    );
    mockDockerService.extractDNSEntries.mockReturnValue(
      mockDockerServiceExtractDNSEntriesValues,
    );

    mockCloudFlareService = module.get(CloudFlareService);
    mockCloudFlareService.getRecords.mockResolvedValue(mockCloudFlareRecords);

    mockConsoleLoggerService = module.get(ConsoleLoggerService);

    mockConfigService = module.get(ConfigService) as DeepMocked<ConfigService>;
    mockConfigService.get.mockImplementation(
      (propertyPath) => mockConfigServiceGetValue[propertyPath],
    );

    mockDdnsService = module.get(DdnsService) as DeepMocked<DdnsService>;
    mockDdnsServiceIsDdnsRequiredValue = false;
    mockDdnsService.isDdnsRequired.mockImplementation(
      () => mockDdnsServiceIsDdnsRequiredValue,
    );
    mockDdnsService.getIPAddress.mockImplementation(
      () => mockDdnsServiceGetIPAddressValue,
    );
    mockDdnsService.getState.mockImplementation(
      () => mockDdnsServiceGetStateValue,
    );

    sut = module.get<AppService>(AppService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  it('should have correct service name', () => {
    expect(sut.ServiceName).toEqual('AppService');
  });

  describe('ExecutionIntervalSeconds property', () => {
    it('should load property from configuration', () => {
      // act / assert
      expect(sut.ExecutionFrequencySeconds).toEqual(
        envExecutionFrequencySeconds,
      );
      expect(mockConfigService.get).toHaveBeenCalledTimes(1);
      expect(mockConfigService.get).toHaveBeenCalledWith(
        'EXECUTION_FREQUENCY_SECONDS',
        { infer: true },
      );
    });
  });

  describe('initialize', () => {
    beforeEach(() => {
      sut['state'] = State.Uninitialized;
    });

    it('should initialize', () => {
      // act
      sut.initialize();

      // assert
      expect(mockCloudFlareService.initialize).toHaveBeenCalledTimes(1);
      expect(mockDockerService.initialize).toHaveBeenCalledTimes(1);
      expect(sut['state']).toBe(State.Initialized);
      expect(mockConsoleLoggerService.verbose).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.verbose).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'trace',
          method: 'initialize',
          service: 'AppService',
          params: '[]',
        }),
      );
    });

    it('should error if cloud-flare.service errors', () => {
      // arrange
      const error = new Error('cloud-flare-error');
      mockCloudFlareService.initialize.mockImplementationOnce(() => {
        throw error;
      });

      // act / assert
      expect(() => sut.initialize()).toThrow(error);
      expect(sut['state']).toBe(State.Uninitialized);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          error: error.stack,
          method: 'initialize',
          service: 'AppService',
          params: '[]',
        }),
      );
    });

    it('should error if docker.service errors', () => {
      // arrange
      const error = new Error('cloud-flare-error');
      mockDockerService.initialize.mockImplementationOnce(() => {
        throw error;
      });

      // act / assert
      expect(() => sut.initialize()).toThrow(error);
      expect(sut['state']).toBe(State.Uninitialized);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          error: error.stack,
          method: 'initialize',
          service: 'AppService',
          params: '[]',
        }),
      );
    });
  });

  describe('synchronise', () => {
    beforeEach(() => {
      // restore mocks cleared in parent beforeEach
      mockCloudFlareService.getRecords.mockResolvedValue(mockCloudFlareRecords);
      mockDockerService.getContainers.mockResolvedValue(mockDockerServiceGetContainersValues);
      mockDockerService.extractDNSEntries.mockReturnValue(mockDockerServiceExtractDNSEntriesValues);
      mockAppFunctionsComputeSetDifference.mockReturnValue(mockAppFunctionsComputeSetDifferenceValue);

      // arrange initial state
      sut['state'] = State.Initialized;
    });

    it('should throw if uninitialized', async () => {
      // arrange
      const expected = new Error(
        'AppService, synchronize: Not initialized, cannot synchronize. Call initialize first',
      );
      sut['state'] = State.Uninitialized;

      // act / assert
      await expect(sut.job()).rejects.toThrow(expected);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          method: 'job',
          service: 'AppService',
          params: '[]',
        }),
      );
    });

    it('should propagate error from prepareForJob', async () => {
      // arrange
      const error = new Error('No zones returned from CloudFlare');
      mockCloudFlareService.prepareForJob.mockRejectedValueOnce(error);

      // act / assert
      await expect(sut.job()).rejects.toThrow(error);
    });

    it('should synchronize', async () => {
      // act
      await sut.job();

      // assert
      expect(mockDockerService.initialize).not.toHaveBeenCalled();
      expect(mockCloudFlareService.initialize).not.toHaveBeenCalled();
      expect(mockCloudFlareService.prepareForJob).toHaveBeenCalledTimes(1);
      expect(mockCloudFlareService.getRecords).toHaveBeenCalledTimes(1);
      expect(mockDockerService.getContainers).toHaveBeenCalledTimes(1);
      expect(mockDockerService.extractDNSEntries).toHaveBeenCalledTimes(1);
      expect(mockDockerService.extractDNSEntries).toHaveBeenCalledWith(
        mockDockerServiceGetContainersValues,
      );
      expect(mockDdnsService.isDdnsRequired).toHaveBeenCalledTimes(1);
      expect(mockDdnsService.isDdnsRequired).toHaveBeenCalledWith(
        mockDockerServiceExtractDNSEntriesValues,
      );
      expect(mockDdnsService.start).not.toHaveBeenCalled();
      expect(mockDdnsService.stop).not.toHaveBeenCalled();
      expect(mockAppFunctionsComputeSetDifference).toHaveBeenCalledTimes(1);
      expect(mockAppFunctionsComputeSetDifference).toHaveBeenCalledWith(
        mockDockerServiceExtractDNSEntriesValues,
        mockCloudFlareRecords,
      );

      const { add, update } = mockAppFunctionsComputeSetDifferenceValue;
      const deletions = mockAppFunctionsComputeSetDifferenceValue.delete;

      expect(mockCloudFlareService.createEntry).toHaveBeenCalledTimes(add.length);
      add.forEach((entry) => {
        expect(mockCloudFlareService.createEntry).toHaveBeenCalledWith(entry);
      });

      expect(mockCloudFlareService.updateEntry).toHaveBeenCalledTimes(update.length);
      update.forEach(({ old, update: desired }) => {
        expect(mockCloudFlareService.updateEntry).toHaveBeenCalledWith(old, desired);
      });

      expect(mockCloudFlareService.deleteEntry).toHaveBeenCalledTimes(deletions.length);
      deletions.forEach((deletion) => {
        expect(mockCloudFlareService.deleteEntry).toHaveBeenCalledWith(deletion);
      });

      expect(mockConsoleLoggerService.debug).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'debug',
          method: 'job',
          service: 'AppService',
          params: '[]',
        }),
      );
      expect(mockConsoleLoggerService.log).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.log).toHaveBeenCalledWith(
        `Synchronisation complete, entries changed: Added ${add.length}, Updated ${update.length}, Deleted ${deletions.length}, Unchanged ${mockAppFunctionsComputeSetDifferenceValue.unchanged.length}`,
      );
    });

    describe('DDNS enabled', () => {
      const ddnsEntryOne = {
        name: 'test-ddns-1',
        type: DNSTypes.A,
        address: 'DDNS',
      } as unknown as DnsbaseEntry;
      const ddnsEntryOneExpected = {
        ...ddnsEntryOne,
        address: mockDdnsServiceGetIPAddressValue,
      };
      const ddnsEntryTwo = {
        name: 'test-ddns-2',
        type: DNSTypes.A,
        address: 'DDNS',
      } as unknown as DnsbaseEntry;
      const ddnsEntryTwoExpected = {
        ...ddnsEntryTwo,
        address: mockDdnsServiceGetIPAddressValue,
      };

      beforeEach(() => {
        mockDockerService.extractDNSEntries.mockReturnValue([
          ddnsEntryOne,
          ...mockDockerServiceExtractDNSEntriesValues,
          ddnsEntryTwo,
        ]);
        mockIsDnsAEntry.mockImplementation(
          (entry) => entry.type === DNSTypes.A,
        );
      });

      it('Should synchronize with DDNS, starting DDNS service', async () => {
        // arrange
        mockDdnsServiceIsDdnsRequiredValue = true;
        mockDdnsServiceGetStateValue = CronState.Stopped;

        // act
        await sut.job();

        // assert
        expect(mockDdnsService.getState).toHaveBeenCalledTimes(1);
        expect(mockDdnsService.start).toHaveBeenCalledTimes(1);
        expect(mockDdnsService.stop).not.toHaveBeenCalled();
        expect(mockDdnsService.getIPAddress).toHaveBeenCalledTimes(1);
        expect(mockAppFunctionsComputeSetDifference).toHaveBeenCalledWith(
          [
            ddnsEntryOneExpected,
            ...mockDockerServiceExtractDNSEntriesValues,
            ddnsEntryTwoExpected,
          ],
          expect.any(Array),
        );
      });

      it('Should syncrhonize with DDNS, but not start service if already started', async () => {
        // arrange
        mockDdnsServiceIsDdnsRequiredValue = true;
        mockDdnsServiceGetStateValue = CronState.Started;

        // act
        await sut.job();

        // assert
        expect(mockDdnsService.start).not.toHaveBeenCalled();
        expect(mockDdnsService.stop).not.toHaveBeenCalled();
        expect(mockDdnsService.getIPAddress).toHaveBeenCalledTimes(1);
        expect(mockAppFunctionsComputeSetDifference).toHaveBeenCalledWith(
          [
            ddnsEntryOneExpected,
            ...mockDockerServiceExtractDNSEntriesValues,
            ddnsEntryTwoExpected,
          ],
          expect.any(Array),
        );
      });

      it('Should stop synchronizing with DDNS if no longer required', async () => {
        // arrange
        mockDdnsServiceGetStateValue = CronState.Started;
        mockDdnsServiceIsDdnsRequiredValue = false;
        mockDockerService.extractDNSEntries.mockReturnValue(
          mockDockerServiceExtractDNSEntriesValues,
        );

        // act
        await sut.job();

        // assert
        expect(mockDdnsService.start).not.toHaveBeenCalled();
        expect(mockDdnsService.stop).toHaveBeenCalledTimes(1);
        expect(mockDdnsService.getIPAddress).not.toHaveBeenCalled();
        expect(mockAppFunctionsComputeSetDifference).toHaveBeenCalledWith(
          mockDockerServiceExtractDNSEntriesValues,
          expect.any(Array),
        );
      });

      it('Should filter out entries and post a warning if IPAddress is undefined', async () => {
        // arrange
        mockDdnsServiceIsDdnsRequiredValue = true;
        mockDdnsServiceGetStateValue = CronState.Started;
        mockDdnsService.getIPAddress.mockReturnValueOnce(undefined);

        // act
        await sut.job();

        // assert
        expect(mockDdnsService.getIPAddress).toHaveBeenCalledTimes(1);
        expect(mockAppFunctionsComputeSetDifference).toHaveBeenCalledWith(
          mockDockerServiceExtractDNSEntriesValues,
          expect.any(Array),
        );
        expect(mockConsoleLoggerService.warn).toHaveBeenCalledTimes(1);
        expect(mockConsoleLoggerService.warn).toHaveBeenCalledWith(
          `DDNS, IPAddress has yet to be fetched successfully. DDNS records have been filtered out.\n          They'll be added in automatically once an IPAddress has been fetched.`,
        );
      });
    });
  });
});
