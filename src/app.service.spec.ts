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
import { IProviderRecord } from './providers/provider-record.interface';

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

function makeProviderRecord(name: string, type = DNSTypes.A): IProviderRecord {
  return {
    id: `${name}-id`,
    name,
    type,
    Key: `${type}:${name}`,
    providerContext: {},
    hasSameValue: jest.fn().mockReturnValue(true),
  };
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
    mockProviderRegistry = module.get(
      ProviderRegistry,
    ) as DeepMocked<ProviderRegistry>;

    mockCfProvider = makeMockProvider('cf');
    mockProviderRegistry.getAll.mockReturnValue([mockCfProvider]);
    mockDdnsService.isDdnsRequired.mockReturnValue(false);
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('initialize', () => {
    it('should reject if already initialized', async () => {
      sut['state'] = State.Initialized;
      await expect(sut.initialize()).rejects.toThrow('Already initialized');
    });

    it('should initialize registry, docker service, and run negotiation', async () => {
      await sut.initialize();
      expect(mockProviderRegistry.initialize).toHaveBeenCalledTimes(1);
      expect(mockDockerService.initialize).toHaveBeenCalledTimes(1);
      // negotiateAll is the new async second-stage init — without it the
      // DomainFilter on each WebhookProvider stays unset (match-all).
      expect(mockProviderRegistry.negotiateAll).toHaveBeenCalledTimes(1);
      expect(sut['state']).toBe(State.Initialized);
    });
  });

  describe('job', () => {
    beforeEach(() => {
      sut['state'] = State.Initialized;
      mockDockerService.getSources.mockResolvedValue([]);
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
      const entry = validDnsAEntry(DnsaEntry, {
        name: 'update.testdomain.com',
        address: '9.9.9.9',
      });
      entry.providers = ['cf'];
      const existingRecord = makeProviderRecord('update.testdomain.com');
      // Make hasSameValue return false — different address
      jest.spyOn(existingRecord, 'hasSameValue').mockReturnValue(false);
      mockDockerService.extractDNSEntries.mockReturnValue([entry]);
      mockCfProvider.getRecords.mockResolvedValue([existingRecord]);

      await sut.job();

      expect(mockCfProvider.updateEntry).toHaveBeenCalledTimes(1);
      expect(mockCfProvider.updateEntry).toHaveBeenCalledWith(
        existingRecord,
        entry,
      );
    });

    it('should filter entries to only those targeting a provider', async () => {
      const cfEntry = validDnsAEntry(DnsaEntry, { name: 'cf.testdomain.com' });
      cfEntry.providers = ['cf'];
      const mikrotikEntry = validDnsAEntry(DnsaEntry, {
        name: 'mikrotik.testdomain.com',
      });
      mikrotikEntry.providers = ['mikrotik'];

      mockDockerService.extractDNSEntries.mockReturnValue([
        cfEntry,
        mikrotikEntry,
      ]);

      await sut.job();

      // cfProvider should only receive cfEntry, not mikrotikEntry
      expect(mockCfProvider.createEntry).toHaveBeenCalledWith(cfEntry);
      expect(mockCfProvider.createEntry).not.toHaveBeenCalledWith(
        mikrotikEntry,
      );
    });

    it('should include "all" entries for every provider', async () => {
      const allEntry = validDnsAEntry(DnsaEntry, {
        name: 'all.testdomain.com',
      });
      allEntry.providers = ['all'];
      mockDockerService.extractDNSEntries.mockReturnValue([allEntry]);

      await sut.job();

      expect(mockCfProvider.createEntry).toHaveBeenCalledWith(allEntry);
    });

    it('should warn and skip duplicates per provider', async () => {
      const entry1 = validDnsAEntry(DnsaEntry, { name: 'dupe.testdomain.com' });
      entry1.providers = ['cf'];
      const entry2 = validDnsAEntry(DnsaEntry, {
        name: 'dupe.testdomain.com',
        address: '2.2.2.2',
      });
      entry2.providers = ['cf'];

      mockDockerService.extractDNSEntries.mockReturnValue([entry1, entry2]);

      const mockLogger = sut[
        'loggerService'
      ] as DeepMocked<ConsoleLoggerService>;

      await sut.job();

      // Both should be skipped — neither createEntry called for 'dupe.testdomain.com'
      expect(mockCfProvider.createEntry).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('duplicate key'),
      );
    });

    it('should propagate error from provider', async () => {
      (mockCfProvider.prepareForJob as jest.Mock).mockRejectedValue(
        new Error('provider error'),
      );
      await expect(sut.job()).rejects.toThrow('provider error');
    });

    describe('per-entry apply failure isolation', () => {
      it('logs WARN naming the entry+reason and continues with siblings when one createEntry fails', async () => {
        const goodEntry = validDnsAEntry(DnsaEntry, {
          name: 'good.testdomain.com',
        });
        goodEntry.providers = ['cf'];
        const badEntry = validDnsAEntry(DnsaEntry, {
          name: 'bad.testdomain.com',
        });
        badEntry.providers = ['cf'];

        mockDockerService.extractDNSEntries.mockReturnValue([
          goodEntry,
          badEntry,
        ]);
        (mockCfProvider.createEntry as jest.Mock).mockImplementation(
          async (e: DnsaEntry) => {
            if (e.name === 'bad.testdomain.com') {
              throw new Error('sidecar refused: not in zone');
            }
          },
        );

        const mockLogger = sut[
          'loggerService'
        ] as DeepMocked<ConsoleLoggerService>;

        // One per-entry failure must NOT abort the cycle.
        await expect(sut.job()).resolves.not.toThrow();

        // Sibling entry still applied.
        expect(mockCfProvider.createEntry).toHaveBeenCalledWith(goodEntry);
        expect(mockCfProvider.createEntry).toHaveBeenCalledWith(badEntry);

        // Failure surfaced with both the entry key and the sidecar reason.
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringMatching(/bad\.testdomain\.com/),
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('sidecar refused'),
        );
      });

      it('does not abort the outer provider loop when one provider rejects every entry', async () => {
        const mockMtProvider = makeMockProvider('mikrotik');
        mockProviderRegistry.getAll.mockReturnValue([
          mockCfProvider,
          mockMtProvider,
        ]);

        const entry = validDnsAEntry(DnsaEntry, {
          name: 'fan.testdomain.com',
        });
        entry.providers = ['all'];
        mockDockerService.extractDNSEntries.mockReturnValue([entry]);

        (mockMtProvider.createEntry as jest.Mock).mockRejectedValue(
          new Error('mikrotik down'),
        );

        await expect(sut.job()).resolves.not.toThrow();

        // Cloudflare provider still ran despite the MikroTik failure.
        expect(mockCfProvider.createEntry).toHaveBeenCalledWith(entry);
      });
    });

    describe('strict provider-name routing', () => {
      it('logs an error per entry referencing an unknown provider, then skips it', async () => {
        const good = validDnsAEntry(DnsaEntry, { name: 'good.example.com' });
        good.providers = ['cf'];
        const typo = validDnsAEntry(DnsaEntry, { name: 'typo.example.com' });
        typo.providers = ['mikrotic-home'];
        mockDockerService.extractDNSEntries.mockReturnValue([good, typo]);
        const loggerMock = sut['loggerService'];

        await sut.job();

        // typo entry never reached the provider
        expect(mockCfProvider.createEntry).toHaveBeenCalledWith(good);
        expect(mockCfProvider.createEntry).not.toHaveBeenCalledWith(typo);

        // and the operator screamed about it
        expect(loggerMock.error).toHaveBeenCalledWith(
          expect.stringContaining('mikrotic-home'),
        );
        expect(loggerMock.error).toHaveBeenCalledWith(
          expect.stringContaining('typo.example.com'),
        );
      });

      it('lists the configured providers in the error so the user can fix it', async () => {
        const typo = validDnsAEntry(DnsaEntry, { name: 'x.example.com' });
        typo.providers = ['mikrotic-home'];
        mockDockerService.extractDNSEntries.mockReturnValue([typo]);
        const loggerMock = sut['loggerService'];

        await sut.job();

        expect(loggerMock.error).toHaveBeenCalledWith(
          expect.stringMatching(/configured providers:\s*\[cf\]/),
        );
      });

      it('rejects the whole entry if ANY name in providers is unknown — partial validity is not enough', async () => {
        const partial = validDnsAEntry(DnsaEntry, {
          name: 'half.example.com',
        });
        partial.providers = ['cf', 'mikrotic-home']; // cf valid, second a typo
        mockDockerService.extractDNSEntries.mockReturnValue([partial]);

        await sut.job();

        expect(mockCfProvider.createEntry).not.toHaveBeenCalled();
      });

      it('still allows the "all" token alongside concrete names', async () => {
        const all = validDnsAEntry(DnsaEntry, { name: 'all.example.com' });
        all.providers = ['all'];
        const targeted = validDnsAEntry(DnsaEntry, {
          name: 'targeted.example.com',
        });
        targeted.providers = ['cf'];
        mockDockerService.extractDNSEntries.mockReturnValue([all, targeted]);

        await sut.job();

        expect(mockCfProvider.createEntry).toHaveBeenCalledWith(all);
        expect(mockCfProvider.createEntry).toHaveBeenCalledWith(targeted);
      });
    });

    describe('domain-filter pre-routing', () => {
      it('skips an entry routed to a provider that does not serve its zone, with a named WARN', async () => {
        const inZone = validDnsAEntry(DnsaEntry, {
          name: 'app.example.com',
        });
        inZone.providers = ['cf'];
        const outOfZone = validDnsAEntry(DnsaEntry, {
          name: 'app.other.com',
        });
        outOfZone.providers = ['cf'];

        // Provider serves only example.com — other.com must be skipped.
        (
          mockCfProvider as unknown as { matchesDomain: jest.Mock }
        ).matchesDomain = jest.fn((name: string) =>
          name.endsWith('example.com'),
        );

        mockDockerService.extractDNSEntries.mockReturnValue([
          inZone,
          outOfZone,
        ]);
        const logger = sut['loggerService'];

        await sut.job();

        expect(mockCfProvider.createEntry).toHaveBeenCalledWith(inZone);
        expect(mockCfProvider.createEntry).not.toHaveBeenCalledWith(outOfZone);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('app.other.com'),
        );
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cf'));
      });

      it('respects providers without a matchesDomain hook (treats as match-all)', async () => {
        const entry = validDnsAEntry(DnsaEntry, {
          name: 'app.example.com',
        });
        entry.providers = ['cf'];
        // No matchesDomain on the mock — older providers without the hook
        // must keep working unchanged.
        delete (mockCfProvider as unknown as { matchesDomain?: jest.Mock })
          .matchesDomain;
        mockDockerService.extractDNSEntries.mockReturnValue([entry]);

        await sut.job();

        expect(mockCfProvider.createEntry).toHaveBeenCalledWith(entry);
      });

      it('on a fan-out (`all`), drops the entry only from providers that do not serve its zone', async () => {
        const mockMtProvider = makeMockProvider('mikrotik');
        mockProviderRegistry.getAll.mockReturnValue([
          mockCfProvider,
          mockMtProvider,
        ]);

        const entry = validDnsAEntry(DnsaEntry, {
          name: 'app.lan',
        });
        entry.providers = ['all'];

        // cf serves only example.com → app.lan dropped for cf.
        (
          mockCfProvider as unknown as { matchesDomain: jest.Mock }
        ).matchesDomain = jest.fn((n: string) => n.endsWith('example.com'));
        // mikrotik serves .lan → app.lan accepted for mikrotik.
        (
          mockMtProvider as unknown as { matchesDomain: jest.Mock }
        ).matchesDomain = jest.fn((n: string) => n.endsWith('.lan'));

        mockDockerService.extractDNSEntries.mockReturnValue([entry]);

        await sut.job();

        expect(mockCfProvider.createEntry).not.toHaveBeenCalled();
        expect(mockMtProvider.createEntry).toHaveBeenCalledWith(entry);
      });
    });
  });

  describe('reactive lifecycle (start/stop)', () => {
    // Captures the callback handed to dockerService.subscribeToEvents so we
    // can fire synthetic events from tests.
    let eventCallback: () => void;
    let unsubscribeSpy: jest.Mock;
    // Waits long enough for the 5 ms debounce timer to fire and the
    // resulting async job to settle. Microtask-only flushes are not enough
    // — debounce uses real setTimeout.
    const waitDebounce = (extraMs = 20) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, extraMs);
      });

    beforeEach(() => {
      sut['state'] = State.Initialized;
      // Job is a no-op for these tests — we're verifying the scheduler,
      // not the reconcile semantics (those have their own describe blocks).
      jest.spyOn(sut, 'job').mockResolvedValue(undefined);
      unsubscribeSpy = jest.fn();
      mockDockerService.subscribeToEvents.mockImplementation(async (cb) => {
        eventCallback = cb;
        return unsubscribeSpy;
      });
      // Use a real, tiny debounce so tests don't sit on fake timers.
      (sut['configService'].get as jest.Mock).mockImplementation(
        (key: string) => {
          if (key === 'EXECUTION_FREQUENCY_SECONDS') return 999_999;
          if (key === 'RECONCILE_DEBOUNCE_MS') return 5;
          return undefined;
        },
      );
    });

    afterEach(() => {
      sut.stop();
    });

    it('subscribes to docker events before scheduling the initial reconcile', async () => {
      await sut.start();

      expect(mockDockerService.subscribeToEvents).toHaveBeenCalledTimes(1);
      // initial reconcile is queued through the debouncer, not executed yet
      expect(sut.job).not.toHaveBeenCalled();
    });

    it('runs the initial reconcile after the debounce window', async () => {
      await sut.start();
      await waitDebounce();

      expect(sut.job).toHaveBeenCalledTimes(1);
    });

    it('coalesces a burst of events into a single reconcile', async () => {
      await sut.start();
      // Burst — all within the debounce window
      eventCallback();
      eventCallback();
      eventCallback();
      eventCallback();
      eventCallback();
      await waitDebounce();

      // 1 reconcile total (initial + burst all coalesced)
      expect(sut.job).toHaveBeenCalledTimes(1);
    });

    it('queues exactly one follow-up reconcile if an event arrives during an in-flight job', async () => {
      // Hold the in-flight job until we release it
      let releaseJob: () => void = () => {};
      const jobPromise = new Promise<void>((resolve) => {
        releaseJob = resolve;
      });
      (sut.job as jest.Mock).mockReturnValueOnce(jobPromise);

      await sut.start();
      // Wait for the initial reconcile to enter "in-progress"
      await waitDebounce();
      expect(sut.job).toHaveBeenCalledTimes(1);

      // Fire multiple events while the job is still running
      eventCallback();
      eventCallback();
      eventCallback();

      // Let the initial job finish
      releaseJob();
      await waitDebounce();

      // One initial run + exactly one follow-up = 2
      expect(sut.job).toHaveBeenCalledTimes(2);
    });

    it('stop() unsubscribes from events and clears timers', async () => {
      await sut.start();
      sut.stop();

      expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
      // After stop, further events must not schedule reconciles
      eventCallback();
      await waitDebounce();
      expect(sut.job).not.toHaveBeenCalled();
    });

    it('stop() during an in-flight job prevents the queued follow-up from running', async () => {
      let releaseJob: () => void = () => {};
      const jobPromise = new Promise<void>((resolve) => {
        releaseJob = resolve;
      });
      (sut.job as jest.Mock).mockReturnValueOnce(jobPromise);

      await sut.start();
      await waitDebounce();
      expect(sut.job).toHaveBeenCalledTimes(1);

      // Queue a follow-up by firing an event mid-job
      eventCallback();
      // Stop while the in-flight job is still running
      sut.stop();
      releaseJob();
      await waitDebounce();

      // No follow-up ran — only the initial in-flight job
      expect(sut.job).toHaveBeenCalledTimes(1);
    });

    it('throws if start() is called after stop()', async () => {
      sut.stop();
      await expect(sut.start()).rejects.toThrow('cannot start after stop');
    });
  });
});
