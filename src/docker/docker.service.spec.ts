import { createMock, DeepMocked } from '@golevelup/ts-jest';
import { Test, TestingModule } from '@nestjs/testing';
import Docker from 'dockerode';
import { ConfigService } from '@nestjs/config';
import each from 'jest-each';
import { validDnsAEntry } from '../dto/dnsa-entry.spec';
import { DnsAaaaEntry } from '../dto/dnsaaaa-entry';
import { validDnsCnameEntry } from '../dto/dnscname-entry.spec';
import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { DockerFactory } from './docker.factory';
import { DockerService, States } from './docker.service';
import { NestedError } from '../errors/nested-error';
import { validDnsMxEntry } from '../dto/dnsmx-entry.spec';
import { validDnsNsEntry } from '../dto/dnsns-entry.spec';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry } from '../dto/dnsns-entry';
import { ConsoleLoggerService } from '../logger.service';

jest.mock('@nestjs/common', () => {
  const mock = jest.createMockFromModule('@nestjs/common') as any;
  const actual = jest.requireActual('@nestjs/common');

  return { ...actual, Logger: mock.Logger };
});

class ContainerInfoBuilder<T extends DnsbaseEntry> {
  labelValues: T[] = [];

  idValue: string;

  constructor(private dockerLabel: string) {}

  WithId(id: string) {
    this.idValue = id;
    return this;
  }

  WithLabel(label: T) {
    this.labelValues.push(label);
    return this;
  }

  Build() {
    const result = createMock<Docker.ContainerInfo>();
    result.Id = this.idValue;
    result.Labels = {
      [this.dockerLabel]: JSON.stringify(this.labelValues),
    };

    this.labelValues = [];

    return result;
  }
}

describe('DockerService', () => {
  const backupProcessEnv = process.env;
  let sut: DockerService;
  let mockDockerFactory: DeepMocked<DockerFactory>;
  let mockConfigService: DeepMocked<ConfigService>;
  let mockConsoleLoggerService: DeepMocked<ConsoleLoggerService>;
  const mockDockerFactoryGetValue = createMock<Docker>();
  const mockDockerListContainersValue: Docker.ContainerInfo[] = [
    'container-info-1',
    'container-info-2',
  ] as unknown as Docker.ContainerInfo[];
  const mockConfigServiceGetValue = {
    ENTRY_IDENTIFIER: 'project-label:instance-id',
    PRESERVE_STOPPED: false,
  };
  let expectedDockerLabel = '';
  let expectedPreserveStopped = false;

  beforeAll(() => {
    const { ENTRY_IDENTIFIER, PRESERVE_STOPPED } = mockConfigServiceGetValue;
    process.env.ENTRY_IDENTIFIER = ENTRY_IDENTIFIER;
    process.env.PRESERVE_STOPPED = PRESERVE_STOPPED.toString();
    expectedDockerLabel = ENTRY_IDENTIFIER;
    expectedPreserveStopped = PRESERVE_STOPPED;
  });

  afterAll(() => {
    process.env = backupProcessEnv;
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DockerService],
    })
      .useMocker(createMock)
      .compile();

    mockDockerFactoryGetValue.listContainers.mockResolvedValue(
      mockDockerListContainersValue,
    );
    mockDockerFactoryGetValue.listServices.mockResolvedValue([]);

    mockDockerFactory = module.get<DockerFactory>(
      DockerFactory,
    ) as DeepMocked<DockerFactory>;
    mockDockerFactory.get.mockReturnValue(mockDockerFactoryGetValue);

    mockConfigService = module.get<ConfigService>(
      ConfigService,
    ) as DeepMocked<ConfigService>;
    mockConfigService.get.mockImplementation(
      (propertyPath) => mockConfigServiceGetValue[propertyPath],
    );

    mockConsoleLoggerService = module.get(ConsoleLoggerService);

    sut = module.get<DockerService>(DockerService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('initialize', () => {
    it('should initialize docker', () => {
      // arrange
      sut['state'] = States.Unintialized;

      // for some unknown reason clearAllMocks doesn't work
      // but manually clearing this get before the test does
      mockDockerFactory.get.mockClear();

      // act
      sut.initialize();

      // assert
      expect(mockDockerFactory.get).toHaveBeenCalledTimes(1);
      expect(sut['docker']).toBe(mockDockerFactoryGetValue);
      // initialize reads ENTRY_IDENTIFIER + PRESERVE_STOPPED. Swarm vs
      // container mode is auto-detected lazily via docker.info() inside
      // resolveSwarmMode() on first getSources() — no config read.
      expect(mockConfigService.get).toHaveBeenCalledTimes(2);
      expect(mockConfigService.get).toHaveBeenCalledWith('ENTRY_IDENTIFIER', {
        infer: true,
      });
      expect(mockConfigService.get).toHaveBeenCalledWith('PRESERVE_STOPPED', {
        infer: true,
      });
      expect(sut['dockerLabel']).toEqual(expectedDockerLabel);
      expect(sut['preserveStopped']).toEqual(expectedPreserveStopped);
      // swarmMode stays undefined until first getSources() — lazy detection.
      expect(sut['swarmMode']).toBeUndefined();
      expect(sut['state']).toBe(States.Initialized);
      expect(mockConsoleLoggerService.verbose).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.verbose).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'trace',
          method: 'initialize',
          service: 'DockerService',
          params: '[]',
        }),
      );
    });

    it('should throw if initialize docker throws', () => {
      // arrange
      sut['state'] = States.Unintialized;

      const factoryError = new Error('error');
      const error = new NestedError(
        'DockerService, initialize: Failed initializing docker service',
        factoryError,
      );
      mockDockerFactory.get.mockImplementationOnce(() => {
        throw factoryError;
      });

      // act / assert
      expect(() => sut.initialize()).toThrow(error);
      expect(sut['state']).toBe(States.Unintialized);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          method: 'initialize',
          service: 'DockerService',
          params: '[]',
        }),
      );
    });

    it('should throw if already initialized', () => {
      // arrange
      sut['state'] = States.Initialized;

      const error = new Error(
        'DockerService, initialize: Failed initializing docker service, service alread initialized',
      );

      // act / assert
      expect(() => sut.initialize()).toThrow(error);
      expect(sut['state']).toBe(States.Initialized);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          method: 'initialize',
          service: 'DockerService',
          params: '[]',
        }),
      );
    });
  });

  describe('initialized methods', () => {
    beforeEach(() => {
      sut['state'] = States.Initialized;
      sut['docker'] = mockDockerFactoryGetValue;
      sut['dockerLabel'] = expectedDockerLabel;
      sut['preserveStopped'] = expectedPreserveStopped;
      sut['swarmMode'] = false;
    });

    describe('getSources (container mode)', () => {
      each([true, false]).it(
        'should return docker containers and filter by label (PRESERVE_STOPPED: %p)',
        async (preserveStopped) => {
          // arrange
          sut['preserveStopped'] = preserveStopped;

          // act
          const result = await sut.getSources();

          // assert
          expect(result).toBe(mockDockerListContainersValue);
          expect(
            mockDockerFactoryGetValue.listContainers,
          ).toHaveBeenCalledTimes(1);
          expect(mockDockerFactoryGetValue.listContainers).toHaveBeenCalledWith(
            {
              all: preserveStopped,
              filters: JSON.stringify({ label: [expectedDockerLabel] }),
            },
          );
          // getSources is decorated → 1 verbose; resolveSwarmMode is also
          // decorated and fires on first call → 1 more verbose.
          expect(mockConsoleLoggerService.verbose).toHaveBeenCalledTimes(2);
          expect(mockConsoleLoggerService.verbose).toHaveBeenCalledWith(
            expect.objectContaining({
              level: 'trace',
              method: 'getSources',
              service: 'DockerService',
              params: '[]',
            }),
          );
        },
      );

      it('should error if getSources errors', async () => {
        // arrange
        const getSourcesError = new Error('error');
        const error = new NestedError(
          'DockerService, getSources: Failed getting sources',
          getSourcesError,
        );
        mockDockerFactoryGetValue.listContainers.mockRejectedValueOnce(
          getSourcesError,
        );

        // act / assert
        await expect(async () => sut.getSources()).rejects.toThrow(error);
        expect(mockConsoleLoggerService.error).toHaveBeenCalledTimes(1);
        expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
          expect.objectContaining({
            level: 'error',
            method: 'getSources',
            service: 'DockerService',
            params: '[]',
          }),
        );
      });

      it('should error if not initialized', async () => {
        // arrange
        sut['state'] = States.Unintialized;
        const error = new Error(
          'DockerService, getSources: not initialized, must call initialize',
        );

        // act / assert
        await expect(async () => sut.getSources()).rejects.toThrow(error);
        expect(mockConsoleLoggerService.error).toHaveBeenCalledTimes(1);
        expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
          expect.objectContaining({
            level: 'error',
            method: 'getSources',
            service: 'DockerService',
            params: '[]',
          }),
        );
      });
    });

    describe('getSources (swarm mode)', () => {
      const mockServiceId = 'service-abc123';
      const mockLabels = { [expectedDockerLabel]: '[]' };

      beforeEach(() => {
        sut['swarmMode'] = true;
      });

      it('should call listServices with status:true and raw object filter and map to DockerSource', async () => {
        // arrange
        const mockService = createMock<Docker.Service>();
        mockService.ID = mockServiceId;
        mockService.Spec = { Labels: mockLabels } as any;
        mockService.ServiceStatus = {
          RunningTasks: 1,
          DesiredTasks: 1,
        } as any;
        mockDockerFactoryGetValue.listServices.mockResolvedValueOnce([
          mockService,
        ]);

        // act
        const result = await sut.getSources();

        // assert
        expect(result).toEqual([{ Id: mockServiceId, Labels: mockLabels }]);
        expect(mockDockerFactoryGetValue.listServices).toHaveBeenCalledWith({
          filters: { label: [expectedDockerLabel] },
          status: true,
        });
        expect(mockDockerFactoryGetValue.listContainers).not.toHaveBeenCalled();
      });

      it('should warn and skip service if Spec.Labels is absent', async () => {
        // arrange
        const mockService = createMock<Docker.Service>();
        mockService.ID = mockServiceId;
        mockService.Spec = {} as any;
        mockDockerFactoryGetValue.listServices.mockResolvedValueOnce([
          mockService,
        ]);

        // act
        const result = await sut.getSources();

        // assert
        expect(result).toEqual([]);
        expect(mockConsoleLoggerService.warn).toHaveBeenCalledWith(
          `DockerService, getSources: service ${mockServiceId} has no labels, skipping`,
        );
      });

      it('should throw NestedError if listServices throws', async () => {
        // arrange
        const serviceError = new Error('swarm error');
        const error = new NestedError(
          'DockerService, getSources: Failed getting sources',
          serviceError,
        );
        mockDockerFactoryGetValue.listServices.mockRejectedValueOnce(
          serviceError,
        );

        // act / assert
        await expect(async () => sut.getSources()).rejects.toThrow(error);
      });

      it('should skip service when RunningTasks=0 and PRESERVE_STOPPED=false', async () => {
        // arrange — service exists but has zero running tasks (crash loop /
        // scaled to 0). PRESERVE_STOPPED=false is the default in this suite.
        const mockService = createMock<Docker.Service>();
        mockService.ID = mockServiceId;
        mockService.Spec = { Labels: mockLabels, Name: 'svc-name' } as any;
        mockService.ServiceStatus = {
          RunningTasks: 0,
          DesiredTasks: 1,
        } as any;
        mockDockerFactoryGetValue.listServices.mockResolvedValueOnce([
          mockService,
        ]);

        // act
        const result = await sut.getSources();

        // assert
        expect(result).toEqual([]);
      });

      it('should include service when RunningTasks=0 and PRESERVE_STOPPED=true', async () => {
        // arrange — same service but operator is configured to keep DNS for
        // stopped/degraded services. Standalone analog: exited container with
        // `all=true` on listContainers.
        sut['preserveStopped'] = true;
        const mockService = createMock<Docker.Service>();
        mockService.ID = mockServiceId;
        mockService.Spec = { Labels: mockLabels, Name: 'svc-name' } as any;
        mockService.ServiceStatus = {
          RunningTasks: 0,
          DesiredTasks: 1,
        } as any;
        mockDockerFactoryGetValue.listServices.mockResolvedValueOnce([
          mockService,
        ]);

        // act
        const result = await sut.getSources();

        // assert
        expect(result).toEqual([{ Id: mockServiceId, Labels: mockLabels }]);
      });

      it('should treat missing ServiceStatus as RunningTasks=0 (defensive)', async () => {
        // arrange — older daemon or unexpected API shape: ServiceStatus may be
        // absent. Conservative: treat as 0 running, defer to PRESERVE_STOPPED.
        const mockService = createMock<Docker.Service>();
        mockService.ID = mockServiceId;
        mockService.Spec = { Labels: mockLabels, Name: 'svc-name' } as any;
        mockService.ServiceStatus = undefined;
        mockDockerFactoryGetValue.listServices.mockResolvedValueOnce([
          mockService,
        ]);

        // act
        const result = await sut.getSources();

        // assert
        expect(result).toEqual([]);
      });
    });

    describe('resolveSwarmMode (lazy auto-detection)', () => {
      beforeEach(() => {
        delete sut['swarmMode'];
      });

      it('auto-detects swarm when daemon is an active manager', async () => {
        (mockDockerFactoryGetValue as any).info = jest.fn().mockResolvedValue({
          Swarm: { LocalNodeState: 'active', ControlAvailable: true },
        });
        expect(await sut['resolveSwarmMode']()).toBe(true);
        expect(sut['swarmMode']).toBe(true);
      });

      it('falls back to container mode when daemon is inactive (no swarm)', async () => {
        (mockDockerFactoryGetValue as any).info = jest.fn().mockResolvedValue({
          Swarm: { LocalNodeState: 'inactive', ControlAvailable: false },
        });
        expect(await sut['resolveSwarmMode']()).toBe(false);
      });

      it('falls back to container mode when daemon is a worker, not manager', async () => {
        (mockDockerFactoryGetValue as any).info = jest.fn().mockResolvedValue({
          Swarm: { LocalNodeState: 'active', ControlAvailable: false },
        });
        expect(await sut['resolveSwarmMode']()).toBe(false);
      });

      it('falls back to container mode and warns when docker.info() fails', async () => {
        (mockDockerFactoryGetValue as any).info = jest
          .fn()
          .mockRejectedValue(new Error('socket-proxy denies /info'));
        expect(await sut['resolveSwarmMode']()).toBe(false);
        expect(mockConsoleLoggerService.warn).toHaveBeenCalledWith(
          expect.stringContaining('falling back to container mode'),
        );
      });

      it('caches the result — second call does not re-query the daemon', async () => {
        const infoMock = jest.fn().mockResolvedValue({
          Swarm: { LocalNodeState: 'active', ControlAvailable: true },
        });
        (mockDockerFactoryGetValue as any).info = infoMock;
        await sut['resolveSwarmMode']();
        await sut['resolveSwarmMode']();
        expect(infoMock).toHaveBeenCalledTimes(1);
      });
    });

    describe('extractDNSEntries', () => {
      const mockAEntry = validDnsAEntry(DnsaEntry);
      const mockCnameEntry = validDnsCnameEntry(DnsCnameEntry);
      // MX/NS entries don't set providers in their factory functions, but after
      // normalization in extractDNSEntries they will have providers: ['cf'].
      const mockMxEntryRaw = validDnsMxEntry(DnsMxEntry);
      const mockNsEntryRaw = validDnsNsEntry(DnsNsEntry);
      // Create proper class instances with providers: ['cf'] to match normalizer output
      const mockMxEntry = Object.assign(new DnsMxEntry(), mockMxEntryRaw, {
        providers: ['cf'],
      });
      const mockNsEntry = Object.assign(new DnsNsEntry(), mockNsEntryRaw, {
        providers: ['cf'],
      });
      const mockMultiLabelAEntry = validDnsAEntry(DnsaEntry, {
        name: 'multilabel-a.test-domain.com',
      });
      const mockMultiLabelCnameEntry = validDnsCnameEntry(DnsCnameEntry, {
        name: 'multilabel-cname.test-domain.com',
      });

      let mockContainerInfoBuilder: ContainerInfoBuilder<DnsbaseEntry>;
      let mockAContainerInfo: Docker.ContainerInfo;
      let mockCnameContainerInfo: Docker.ContainerInfo;
      let mockMultiLabelContainerInfo: Docker.ContainerInfo;
      let mockMxContainerInfo: Docker.ContainerInfo;
      let mockNsContainerInfo: Docker.ContainerInfo;

      beforeAll(() => {
        mockContainerInfoBuilder = new ContainerInfoBuilder(
          expectedDockerLabel,
        );

        mockAContainerInfo = mockContainerInfoBuilder
          .WithId('id-a')
          .WithLabel(mockAEntry)
          .Build();

        mockCnameContainerInfo = mockContainerInfoBuilder
          .WithId('id-cname')
          .WithLabel(mockCnameEntry)
          .Build();

        mockMultiLabelContainerInfo = mockContainerInfoBuilder
          .WithId('id-multilabel')
          .WithLabel(mockMultiLabelAEntry)
          .WithLabel(mockMultiLabelCnameEntry)
          .Build();

        mockMxContainerInfo = mockContainerInfoBuilder
          .WithId('id-mx')
          .WithLabel(mockMxEntryRaw)
          .Build();

        mockNsContainerInfo = mockContainerInfoBuilder
          .WithId('id-ns')
          .WithLabel(mockNsEntryRaw)
          .Build();
      });

      const createMockContainers = (mockToTest: Docker.ContainerInfo) => [
        mockAContainerInfo,
        mockToTest,
        mockNsContainerInfo,
      ];
      const createMockContainersDefaultValidResult = [mockAEntry, mockNsEntry];
      const createMockContainersDefaultValidMultiLabelResult = [
        mockAEntry,
        mockMxEntry,
        mockNsEntry,
      ];

      it('should deserialize successfully', () => {
        // arrange
        const paramContainers = [
          mockAContainerInfo,
          mockCnameContainerInfo,
          mockMultiLabelContainerInfo,
          mockMxContainerInfo,
          mockNsContainerInfo,
        ];
        const expected = [
          mockAEntry,
          mockCnameEntry,
          mockMultiLabelAEntry,
          mockMultiLabelCnameEntry,
          mockMxEntry,
          mockNsEntry,
        ];

        // act / assert
        expect(sut.extractDNSEntries(paramContainers)).toEqual(expected);
        expect(mockConsoleLoggerService.warn).not.toHaveBeenCalled();
        expect(mockConsoleLoggerService.debug).toHaveBeenCalledTimes(1);
        expect(mockConsoleLoggerService.debug).toHaveBeenCalledWith(
          expect.objectContaining({
            level: 'debug',
            method: 'extractDNSEntries',
            service: 'DockerService',
          }),
        );
      });

      it('extracts AAAA records from a JSON-array label', () => {
        const aaaaContainer = mockContainerInfoBuilder
          .WithId('id-aaaa')
          .Build();
        aaaaContainer.Labels[expectedDockerLabel] = JSON.stringify([
          {
            type: DNSTypes.AAAA,
            name: 'ipv6.example.com',
            address: '2001:db8::1',
            providers: ['rfc2136'],
          },
        ]);

        const entries = sut.extractDNSEntries([aaaaContainer]);
        expect(entries).toHaveLength(1);
        expect(entries[0].type).toBe(DNSTypes.AAAA);
        expect(entries[0].name).toBe('ipv6.example.com');
        expect((entries[0] as DnsAaaaEntry).address).toBe('2001:db8::1');
        expect(entries[0].providers).toEqual(['rfc2136']);
      });

      it('should return all entries including duplicates (dedup is handled upstream)', () => {
        // Dedup logic has been moved out of DockerService to AppService.
        // DockerService now returns all valid entries, including those with
        // the same Key, without filtering or warning about duplicates.
        const duplicateCnameEntry = {
          ...mockCnameEntry,
          target: 'something-else.com',
        } as DnsCnameEntry;
        const paramContainers = [
          mockAContainerInfo,
          mockCnameContainerInfo,
          mockContainerInfoBuilder
            .WithId('id-cname-dup')
            .WithLabel(duplicateCnameEntry)
            .Build(),
        ];

        // act
        const result = sut.extractDNSEntries(paramContainers);

        // assert — all three entries are returned; no dedup warnings
        expect(result).toHaveLength(3);
        expect(mockConsoleLoggerService.warn).not.toHaveBeenCalled();
      });

      it('should warn and ignore if type is Unsupported, but process other valid entries', () => {
        // arrange
        const mockUnsupportedEntry = {
          ...mockAEntry,
          type: DNSTypes.Unsupported,
        } as unknown as DnsbaseEntry;
        const mockUnsupportedContainerInfo = mockContainerInfoBuilder
          .WithId('id-unsupported')
          .WithLabel(mockUnsupportedEntry)
          .WithLabel(mockAEntry)
          .Build();

        // act / assert
        expect(sut.extractDNSEntries([mockUnsupportedContainerInfo])).toEqual([
          mockAEntry,
        ]);
        expect(mockConsoleLoggerService.warn).toHaveBeenCalledTimes(1);
        expect(mockConsoleLoggerService.warn).toHaveBeenCalledWith(
          `DockerService, extractDNSEntries: source with id ${mockUnsupportedContainerInfo.Id} is using 'Unsupported' type, it will be ignored`,
        );
      });

      each(['', '  ', 'dsoifhadsopifhgas']).it(
        "should warn and ignore if label ('%p') isn't JSON",
        (label) => {
          // arrange
          const mockContainerInfo = createMock<Docker.ContainerInfo>();
          mockContainerInfo.Id = 'conatiner-info-id';
          mockContainerInfo.Labels = { [expectedDockerLabel]: label };
          const paramContainers = createMockContainers(mockContainerInfo);

          // act
          const result = sut.extractDNSEntries(paramContainers);

          // assert
          expect(result).toStrictEqual(createMockContainersDefaultValidResult);
          expect(mockConsoleLoggerService.warn).toHaveBeenCalledTimes(1);
          expect(mockConsoleLoggerService.warn).toHaveBeenCalledWith(
            `DockerService, extractDNSEntries: source with id ${mockContainerInfo.Id} has a non JSON formatted label`,
          );
        },
      );

      each([
        JSON.stringify({ something: 'hi', boo: 1 }),
        JSON.stringify({ type: 'invalid', something: 'hi', boo: 1 }),
        JSON.stringify({
          name: 'name',
          server: '1.4.774.22',
          test: new Date(),
        }),
        JSON.stringify({ type: -1, name: 'invalid-2' }),
        '1234',
        'true',
      ]).it(
        "should warn and ignore if it is JSON but it's unrecognised ('%p')",
        (label) => {
          // arrange
          const mockContainerInfo = createMock<Docker.ContainerInfo>();
          mockContainerInfo.Id = 'conatiner-info-id';
          mockContainerInfo.Labels = { [expectedDockerLabel]: label };
          const paramContainers = createMockContainers(mockContainerInfo);

          // act
          const result = sut.extractDNSEntries(paramContainers);

          // assert
          expect(result).toStrictEqual(createMockContainersDefaultValidResult);
          expect(mockConsoleLoggerService.warn).toHaveBeenCalledTimes(1);
          expect(mockConsoleLoggerService.warn).toHaveBeenCalledWith(
            `DockerService, extractDNSEntries: source with id ${mockContainerInfo.Id} has an unrecognised shape, check the values`,
          );
        },
      );

      each(['[]', '[     ]']).it(
        "should warn and ignore if it is empty JSON array ('%p')",
        (label) => {
          // arrange
          const mockContainerInfo = createMock<Docker.ContainerInfo>();
          mockContainerInfo.Id = 'conatiner-info-id';
          mockContainerInfo.Labels = { [expectedDockerLabel]: label };
          const paramContainers = createMockContainers(mockContainerInfo);

          // act
          const result = sut.extractDNSEntries(paramContainers);

          // assert
          expect(result).toStrictEqual(createMockContainersDefaultValidResult);
          expect(mockConsoleLoggerService.warn).toHaveBeenCalledTimes(1);
          expect(mockConsoleLoggerService.warn).toHaveBeenCalledWith(
            `DockerService, extractDNSEntries: source with id ${mockContainerInfo.Id} has empty array for a label and has been ignored`,
          );
        },
      );

      each([
        'true',
        '12345',
        JSON.stringify({ some: 'test', garbage: false }),
      ]).it(
        "should warn and ignore if it is a JSON array with an unrecognised value ('%p'), but process other valid entries",
        (garbage) => {
          // arrange
          const mockContainerInfo = createMock<Docker.ContainerInfo>();
          mockContainerInfo.Id = 'conatiner-info-id';
          mockContainerInfo.Labels = {
            [expectedDockerLabel]: JSON.stringify([garbage, mockMxEntry]),
          };
          const paramContainers = createMockContainers(mockContainerInfo);

          // act
          const result = sut.extractDNSEntries(paramContainers);

          // assert
          expect(result).toStrictEqual(
            createMockContainersDefaultValidMultiLabelResult,
          );
          expect(mockConsoleLoggerService.warn).toHaveBeenCalledTimes(1);
          expect(mockConsoleLoggerService.warn).toHaveBeenCalledWith(
            `DockerService, extractDNSEntries: source with id ${mockContainerInfo.Id} has an unrecognised shape, check the values`,
          );
        },
      );

      it('should warn and ignore if invalid, but process other valid entries', () => {
        // arrange
        const mockAEntryInvalid = { ...mockAEntry };
        mockAEntryInvalid.address = 'not-an-ip-address';
        const mockContainerInfo = mockContainerInfoBuilder
          .WithId('id-a')
          .WithLabel(mockAEntryInvalid as DnsaEntry)
          .WithLabel(mockMxEntry)
          .Build();
        const paramContainers = createMockContainers(mockContainerInfo);

        // act
        const result = sut.extractDNSEntries(paramContainers);

        // assert
        expect(result).toEqual(
          createMockContainersDefaultValidMultiLabelResult,
        );
        expect(mockConsoleLoggerService.warn).toHaveBeenCalledTimes(1);
        expect(mockConsoleLoggerService.warn).toHaveBeenCalledWith(
          `DockerService, extractDNSEntries: source with id ${mockContainerInfo.Id} has validation errors`,
          expect.arrayContaining([
            expect.objectContaining({
              property: 'address',
              value: mockAEntryInvalid.address,
            }),
          ]),
        );
        // TODO output the errors as context
        // Resume from this location
        // Consider mocking class-validator and wiring up it's errors for these unit tests.
        // Will still require integration test
      });

      it('should warn and ignore if id is present, but process other valid entries', () => {
        // arrange
        const mockAEntryWithId = {
          ...mockAEntry,
        } as unknown as DnsbaseEntry & { id: string };
        mockAEntryWithId.id = 'cloudflare-id-value';
        const mockContainerInfo = mockContainerInfoBuilder
          .WithId('id-a')
          .WithLabel(mockAEntryWithId)
          .WithLabel(mockMxEntry)
          .Build();
        const paramContainers = createMockContainers(mockContainerInfo);

        // act
        const result = sut.extractDNSEntries(paramContainers);

        // assert
        expect(result).toStrictEqual(
          createMockContainersDefaultValidMultiLabelResult,
        );
        expect(mockConsoleLoggerService.warn).toHaveBeenCalledTimes(1);
        expect(mockConsoleLoggerService.warn).toHaveBeenCalledWith(
          `DockerService, extractDNSEntries: source with id ${mockContainerInfo.Id} has 'id' within it's JSON label, please remove it`,
        );
      });

      it('should error if not initialized', () => {
        // arrange
        sut['state'] = States.Unintialized;
        const error = new Error(
          'DockerService, extractDNSEntries: not initialized, must call initialize',
        );

        // act / assert
        expect(() => sut.extractDNSEntries([mockAContainerInfo])).toThrow(
          error,
        );
        expect(mockConsoleLoggerService.error).toHaveBeenCalledTimes(1);
        expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
          expect.objectContaining({
            level: 'error',
            method: 'extractDNSEntries',
            service: 'DockerService',
          }),
        );
      });
    });
  });
});
