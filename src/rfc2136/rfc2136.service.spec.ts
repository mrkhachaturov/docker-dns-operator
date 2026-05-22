import { Test } from '@nestjs/testing';
import { createMock, DeepMocked } from '@golevelup/ts-jest';
import { ConfigService } from '@nestjs/config';
import { Rfc2136Service } from './rfc2136.service';
import { Rfc2136Factory } from './rfc2136.factory';
import { Rfc2136TransportClient } from './transport-client';
import { Rfc2136ProviderRecord } from './rfc2136-provider-record';
import { ConsoleLoggerService } from '../logger.service';

describe('Rfc2136Service', () => {
  let service: Rfc2136Service;
  let transport: DeepMocked<Rfc2136TransportClient>;
  let factory: DeepMocked<Rfc2136Factory>;
  let config: DeepMocked<ConfigService>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let logger: DeepMocked<ConsoleLoggerService>;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        Rfc2136Service,
        {
          provide: Rfc2136TransportClient,
          useValue: createMock<Rfc2136TransportClient>(),
        },
        { provide: Rfc2136Factory, useValue: createMock<Rfc2136Factory>() },
        { provide: ConfigService, useValue: createMock<ConfigService>() },
        {
          provide: ConsoleLoggerService,
          useValue: createMock<ConsoleLoggerService>(),
        },
      ],
    }).compile();
    service = mod.get(Rfc2136Service);
    transport = mod.get(Rfc2136TransportClient);
    factory = mod.get(Rfc2136Factory);
    config = mod.get(ConfigService);
    logger = mod.get(ConsoleLoggerService);
  });

  describe('providerKey', () => {
    it('is "rfc2136"', () => {
      expect(service.providerKey).toBe('rfc2136');
    });
  });

  describe('isConfigured', () => {
    it('returns true when all required env vars are set', () => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS: 'dc01.corp.example.com',
              RFC2136_ZONES: 'corp.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
            }) as Record<string, unknown>
          )[key],
      );
      expect(service.isConfigured()).toBe(true);
    });

    it('returns false when no RFC2136_* vars are set', () => {
      config.get.mockReturnValue(undefined);
      expect(service.isConfigured()).toBe(false);
    });
  });

  describe('initialize', () => {
    it('silently no-ops when not configured', () => {
      config.get.mockReturnValue(undefined);
      expect(() => service.initialize()).not.toThrow();
    });
  });

  describe('probeSidecar', () => {
    beforeEach(() => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS: 'dc01.corp.example.com',
              RFC2136_ZONES: 'corp.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
            }) as Record<string, unknown>
          )[key],
      );
      service.initialize();
    });

    it('resolves when sidecar reports kerberos ready on first try', async () => {
      transport.health.mockResolvedValue({
        ok: true,
        kerberos: 'ready',
        detail: '',
      });
      await expect(service.probeSidecar(3, 1)).resolves.toBeUndefined();
    });

    it('retries and eventually throws if sidecar never reaches ready', async () => {
      transport.health.mockResolvedValue({ ok: false, detail: 'starting' });
      await expect(service.probeSidecar(3, 1)).rejects.toThrow(
        /never returned ready/,
      );
      expect(transport.health).toHaveBeenCalledTimes(3);
    });
  });

  describe('prepareForJob', () => {
    beforeEach(() => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS: 'dc01.corp.example.com,dc02.corp.example.com',
              RFC2136_PORT: 53,
              RFC2136_ZONES: 'zone-a.example.com,zone-b.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
              RFC2136_AXFR_TIMEOUT_SECONDS: 5,
              RFC2136_CIRCUIT_BREAKER_THRESHOLD: 3,
            }) as Record<string, unknown>
          )[key],
      );
      service.initialize();
    });

    it('pins first successful DC per zone', async () => {
      transport.getRecords.mockImplementation(async (req) => {
        if (
          req.host === 'dc01.corp.example.com' &&
          req.zone === 'zone-a.example.com'
        ) {
          return { ok: true, records: [] };
        }
        if (
          req.host === 'dc01.corp.example.com' &&
          req.zone === 'zone-b.example.com'
        ) {
          return {
            ok: false,
            phase: 'dns-send',
            message: 'timeout',
            retryable: true,
          };
        }
        if (
          req.host === 'dc02.corp.example.com' &&
          req.zone === 'zone-b.example.com'
        ) {
          return { ok: true, records: [] };
        }
        return {
          ok: false,
          phase: 'dns-send',
          message: '',
          retryable: false,
        };
      });

      await service.prepareForJob();
      expect((service as any).pinnedDcForZone.get('zone-a.example.com')).toBe(
        'dc01.corp.example.com',
      );
      expect((service as any).pinnedDcForZone.get('zone-b.example.com')).toBe(
        'dc02.corp.example.com',
      );
      expect((service as any).unhealthyZonesThisCycle.size).toBe(0);
    });

    it('marks zone unhealthy when all DCs fail AXFR', async () => {
      transport.getRecords.mockResolvedValue({
        ok: false,
        phase: 'dns-send',
        message: 'timeout',
        retryable: true,
      });
      await service.prepareForJob();
      expect(
        (service as any).unhealthyZonesThisCycle.has('zone-a.example.com'),
      ).toBe(true);
      expect(
        (service as any).unhealthyZonesThisCycle.has('zone-b.example.com'),
      ).toBe(true);
    });

    it('caches successful AXFR records per zone', async () => {
      transport.getRecords.mockResolvedValue({
        ok: true,
        records: [
          {
            name: 'a.zone-a.example.com',
            type: 'A',
            ttl: 300,
            value: '10.0.0.1',
          },
        ],
      });
      await service.prepareForJob();
      expect(
        (service as any).rawAxfrCache.get('zone-a.example.com'),
      ).toHaveLength(1);
    });

    it('resets per-cycle state on each call', async () => {
      transport.getRecords.mockResolvedValue({ ok: true, records: [] });
      await service.prepareForJob();
      (service as any).unhealthyZonesThisCycle.add('zone-a.example.com');
      (service as any).pinnedDcForZone.set(
        'zone-a.example.com',
        'dc01.corp.example.com',
      );
      await service.prepareForJob();
      expect((service as any).unhealthyZonesThisCycle.size).toBe(0);
    });

    it('skips DCs in open circuit-breaker state', async () => {
      (service as any).dcCircuitOpenUntil.set(
        'dc01.corp.example.com',
        Date.now() + 60_000,
      );
      transport.getRecords.mockImplementation(async (req) => {
        if (req.host === 'dc01.corp.example.com') {
          throw new Error('should not be called — circuit open');
        }
        return { ok: true, records: [] };
      });
      await service.prepareForJob();
      expect((service as any).pinnedDcForZone.get('zone-a.example.com')).toBe(
        'dc02.corp.example.com',
      );
    });

    it('counts a multi-zone failure as ONE consecutive cycle failure for the DC', async () => {
      transport.getRecords.mockImplementation(async (req) =>
        req.host === 'dc01.corp.example.com'
          ? {
              ok: false,
              phase: 'dns-send',
              message: 'fail',
              retryable: true,
            }
          : { ok: true, records: [] },
      );
      await service.prepareForJob();
      expect(
        (service as any).dcConsecutiveFailures.get('dc01.corp.example.com'),
      ).toBe(1);
      expect(
        (service as any).dcCircuitOpenUntil.has('dc01.corp.example.com'),
      ).toBe(false);
    });

    it('opens circuit on DC after N consecutive cycles of failure', async () => {
      transport.getRecords.mockImplementation(async (req) =>
        req.host === 'dc01.corp.example.com'
          ? {
              ok: false,
              phase: 'dns-send',
              message: 'fail',
              retryable: true,
            }
          : { ok: true, records: [] },
      );
      await service.prepareForJob();
      await service.prepareForJob();
      await service.prepareForJob();
      expect(
        (service as any).dcCircuitOpenUntil.has('dc01.corp.example.com'),
      ).toBe(true);
    });

    it('resets consecutive cycle count on any successful AXFR for the DC', async () => {
      (service as any).dcConsecutiveFailures.set('dc01.corp.example.com', 2);
      transport.getRecords.mockResolvedValue({ ok: true, records: [] });
      await service.prepareForJob();
      expect(
        (service as any).dcConsecutiveFailures.get('dc01.corp.example.com'),
      ).toBe(0);
    });
  });

  describe('getRecords', () => {
    beforeEach(() => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS: 'dc01.corp.example.com',
              RFC2136_PORT: 53,
              RFC2136_ZONES: 'zone-a.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
              PROJECT_LABEL: 'docker-compose-external-dns',
              INSTANCE_ID: '1',
            }) as Record<string, unknown>
          )[key],
      );
      service.initialize();
    });

    it('returns only records whose ownership TXT matches our instance', async () => {
      (service as any).rawAxfrCache.set('zone-a.example.com', [
        {
          name: 'app.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.1',
        },
        {
          name: 'dnsync-a.app.zone-a.example.com',
          type: 'TXT',
          ttl: 300,
          value: '"owned-by=docker-compose-external-dns:1"',
        },
        {
          name: 'unowned.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.99',
        },
        {
          name: 'other-inst.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.50',
        },
        {
          name: 'dnsync-a.other-inst.zone-a.example.com',
          type: 'TXT',
          ttl: 300,
          value: '"owned-by=docker-compose-external-dns:2"',
        },
      ]);

      const records = await service.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0].name).toBe('app.zone-a.example.com');
      expect(records[0].type).toBe('A');
    });

    it('returns nothing for unhealthy zones', async () => {
      (service as any).rawAxfrCache.set('zone-a.example.com', [
        {
          name: 'app.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.1',
        },
        {
          name: 'dnsync-a.app.zone-a.example.com',
          type: 'TXT',
          ttl: 300,
          value: '"owned-by=docker-compose-external-dns:1"',
        },
      ]);
      (service as any).unhealthyZonesThisCycle.add('zone-a.example.com');

      const records = await service.getRecords();
      expect(records).toHaveLength(0);
    });

    it('excludes ownership TXTs themselves from the returned records', async () => {
      (service as any).rawAxfrCache.set('zone-a.example.com', [
        {
          name: 'app.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.1',
        },
        {
          name: 'dnsync-a.app.zone-a.example.com',
          type: 'TXT',
          ttl: 300,
          value: '"owned-by=docker-compose-external-dns:1"',
        },
      ]);
      const records = await service.getRecords();
      expect(records.every((r) => String(r.type) !== 'TXT')).toBe(true);
    });
  });

  describe('createEntry', () => {
    beforeEach(() => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS: 'dc01.corp.example.com',
              RFC2136_PORT: 53,
              RFC2136_ZONES: 'zone-a.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
              RFC2136_DEFAULT_TTL: 300,
              RFC2136_MIN_TTL: 60,
              PROJECT_LABEL: 'docker-compose-external-dns',
              INSTANCE_ID: '1',
            }) as Record<string, unknown>
          )[key],
      );
      service.initialize();
      (service as any).pinnedDcForZone.set(
        'zone-a.example.com',
        'dc01.corp.example.com',
      );
    });

    it('calls transport.apply on pinned DC with factory output', async () => {
      factory.buildCreateChangeSet.mockReturnValue({
        prerequisites: [
          { kind: 'NXRRSET', name: 'app.zone-a.example.com', type: 'A' },
        ],
        changes: [
          {
            op: 'add',
            record: {
              name: 'app.zone-a.example.com',
              type: 'A',
              ttl: 300,
              value: '10.0.0.1',
            },
          },
        ],
      });
      transport.apply.mockResolvedValue({ ok: true });

      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);

      expect(transport.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'dc01.corp.example.com',
          zone: 'zone-a.example.com',
          changes: expect.any(Array),
          prerequisites: expect.any(Array),
        }),
        expect.any(Number),
      );
    });

    it('skips when zone is unhealthy', async () => {
      (service as any).unhealthyZonesThisCycle.add('zone-a.example.com');
      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);
      expect(transport.apply).not.toHaveBeenCalled();
    });

    it('skips when AXFR cache shows an unowned record at target name+type', async () => {
      (service as any).rawAxfrCache.set('zone-a.example.com', [
        {
          name: 'app.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.9.9.9',
        },
      ]);
      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);
      expect(transport.apply).not.toHaveBeenCalled();
    });

    it('marks zone unhealthy on write failure (so siblings will be skipped)', async () => {
      factory.buildCreateChangeSet.mockReturnValue({
        prerequisites: [],
        changes: [],
      });
      transport.apply.mockResolvedValue({
        ok: false,
        rcode: 'SERVFAIL',
        phase: 'dns-receive',
        message: 'server fail',
        retryable: true,
      });

      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);
      expect(
        (service as any).unhealthyZonesThisCycle.has('zone-a.example.com'),
      ).toBe(true);
    });

    it('rejects entry whose name does not match any configured zone', async () => {
      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.unknown-zone.example.com',
        address: '10.0.0.1',
      });
      await expect(service.createEntry(entry)).resolves.toBeUndefined();
      expect(transport.apply).not.toHaveBeenCalled();
    });
  });

  describe('updateEntry', () => {
    beforeEach(() => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS: 'dc01.corp.example.com',
              RFC2136_PORT: 53,
              RFC2136_ZONES: 'zone-a.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
              PROJECT_LABEL: 'docker-compose-external-dns',
              INSTANCE_ID: '1',
            }) as Record<string, unknown>
          )[key],
      );
      service.initialize();
      (service as any).pinnedDcForZone.set(
        'zone-a.example.com',
        'dc01.corp.example.com',
      );
    });

    it('calls transport.apply with factory update change set', async () => {
      const oldRec = new Rfc2136ProviderRecord(
        {
          name: 'app.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.1',
        },
        'zone-a.example.com',
        { defaultTtl: 3600, minTtl: 60 },
      );
      factory.buildUpdateChangeSet.mockReturnValue({
        prerequisites: [
          {
            kind: 'YXRRSET',
            name: 'dnsync-a.app.zone-a.example.com',
            type: 'TXT',
            value: '"owned-by=docker-compose-external-dns:1"',
          },
        ],
        changes: [
          {
            op: 'delete',
            record: {
              name: 'app.zone-a.example.com',
              type: 'A',
              ttl: 300,
              value: '10.0.0.1',
            },
          },
          {
            op: 'add',
            record: {
              name: 'app.zone-a.example.com',
              type: 'A',
              ttl: 300,
              value: '10.0.0.99',
            },
          },
        ],
      });
      transport.apply.mockResolvedValue({ ok: true });

      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const desired = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.99',
      });
      await service.updateEntry(oldRec, desired);
      expect(transport.apply).toHaveBeenCalled();
    });

    it('skips when zone is unhealthy', async () => {
      (service as any).unhealthyZonesThisCycle.add('zone-a.example.com');
      const oldRec = new Rfc2136ProviderRecord(
        {
          name: 'app.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.1',
        },
        'zone-a.example.com',
        { defaultTtl: 3600, minTtl: 60 },
      );
      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const desired = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.99',
      });
      await service.updateEntry(oldRec, desired);
      expect(transport.apply).not.toHaveBeenCalled();
    });
  });

  describe('deleteEntry', () => {
    beforeEach(() => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS: 'dc01.corp.example.com',
              RFC2136_PORT: 53,
              RFC2136_ZONES: 'zone-a.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
              PROJECT_LABEL: 'docker-compose-external-dns',
              INSTANCE_ID: '1',
            }) as Record<string, unknown>
          )[key],
      );
      service.initialize();
      (service as any).pinnedDcForZone.set(
        'zone-a.example.com',
        'dc01.corp.example.com',
      );
    });

    it('calls transport.apply with factory delete change set', async () => {
      const oldRec = new Rfc2136ProviderRecord(
        {
          name: 'app.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.1',
        },
        'zone-a.example.com',
        { defaultTtl: 3600, minTtl: 60 },
      );
      factory.buildDeleteChangeSet.mockReturnValue({
        prerequisites: [
          {
            kind: 'YXRRSET',
            name: 'dnsync-a.app.zone-a.example.com',
            type: 'TXT',
            value: '"owned-by=docker-compose-external-dns:1"',
          },
        ],
        changes: [
          {
            op: 'delete',
            record: {
              name: 'app.zone-a.example.com',
              type: 'A',
              ttl: 300,
              value: '10.0.0.1',
            },
          },
          {
            op: 'delete',
            record: {
              name: 'dnsync-a.app.zone-a.example.com',
              type: 'TXT',
              ttl: 0,
              value: '"owned-by=docker-compose-external-dns:1"',
            },
          },
        ],
      });
      transport.apply.mockResolvedValue({ ok: true });
      await service.deleteEntry(oldRec);
      expect(transport.apply).toHaveBeenCalled();
    });
  });

  describe('multi-DC failover on write', () => {
    beforeEach(() => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS:
                'dc01.corp.example.com,dc02.corp.example.com,dc03.corp.example.com',
              RFC2136_PORT: 53,
              RFC2136_ZONES: 'zone-a.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
              RFC2136_DEFAULT_TTL: 300,
              RFC2136_MIN_TTL: 60,
              PROJECT_LABEL: 'docker-compose-external-dns',
              INSTANCE_ID: '1',
            }) as Record<string, unknown>
          )[key],
      );
      service.initialize();
      (service as any).pinnedDcForZone.set(
        'zone-a.example.com',
        'dc01.corp.example.com',
      );
      (service as any).availableDcsThisCycle = [
        'dc01.corp.example.com',
        'dc02.corp.example.com',
        'dc03.corp.example.com',
      ];
      factory.buildCreateChangeSet.mockReturnValue({
        prerequisites: [],
        changes: [],
      });
    });

    it('retries on next DC after first returns REFUSED — succeeds on DC2', async () => {
      transport.apply.mockImplementation(async (req) => {
        if (req.host === 'dc01.corp.example.com') {
          return {
            ok: false,
            rcode: 'REFUSED',
            phase: 'dns-receive',
            message: 'denied',
            retryable: false,
          };
        }
        return { ok: true };
      });

      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);

      expect(transport.apply).toHaveBeenCalledTimes(2);
      expect(transport.apply).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ host: 'dc01.corp.example.com' }),
        expect.any(Number),
      );
      expect(transport.apply).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ host: 'dc02.corp.example.com' }),
        expect.any(Number),
      );
      expect(
        (service as any).unhealthyZonesThisCycle.has('zone-a.example.com'),
      ).toBe(false);
      // Pin migrates to the working DC.
      expect((service as any).pinnedDcForZone.get('zone-a.example.com')).toBe(
        'dc02.corp.example.com',
      );
    });

    it('marks zone unhealthy after ALL DCs exhausted', async () => {
      transport.apply.mockResolvedValue({
        ok: false,
        rcode: 'SERVFAIL',
        phase: 'dns-receive',
        message: 'fail',
        retryable: true,
      });

      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);

      expect(transport.apply).toHaveBeenCalledTimes(3);
      expect(
        (service as any).unhealthyZonesThisCycle.has('zone-a.example.com'),
      ).toBe(true);
    });

    it('does not failover on non-retryable, non-failover-eligible failure (e.g. NXRRSET)', async () => {
      transport.apply.mockResolvedValue({
        ok: false,
        rcode: 'NXRRSET',
        phase: 'dns-receive',
        message: 'prereq failed',
        retryable: false,
      });

      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);

      expect(transport.apply).toHaveBeenCalledTimes(1);
      expect(
        (service as any).unhealthyZonesThisCycle.has('zone-a.example.com'),
      ).toBe(true);
    });
  });

  describe('orphan ownership TXT handling', () => {
    beforeEach(() => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS: 'dc01.corp.example.com',
              RFC2136_PORT: 53,
              RFC2136_ZONES: 'zone-a.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
              RFC2136_DEFAULT_TTL: 300,
              RFC2136_MIN_TTL: 60,
              PROJECT_LABEL: 'docker-compose-external-dns',
              INSTANCE_ID: '1',
            }) as Record<string, unknown>
          )[key],
      );
      service.initialize();
    });

    it('detects orphan ownership TXT during prepareForJob and createEntry omits NXRRSET-TXT prereq', async () => {
      transport.getRecords.mockResolvedValue({
        ok: true,
        records: [
          {
            name: 'dnsync-a.app.zone-a.example.com',
            type: 'TXT',
            ttl: 300,
            value: '"owned-by=docker-compose-external-dns:1"',
          },
        ],
      });
      await service.prepareForJob();
      expect(
        (service as any).orphanOwnershipNames.has(
          'dnsync-a.app.zone-a.example.com',
        ),
      ).toBe(true);

      factory.buildCreateChangeSet.mockReturnValue({
        prerequisites: [
          { kind: 'NXRRSET', name: 'app.zone-a.example.com', type: 'A' },
        ],
        changes: [
          {
            op: 'add',
            record: {
              name: 'app.zone-a.example.com',
              type: 'A',
              ttl: 300,
              value: '10.0.0.1',
            },
          },
        ],
      });
      transport.apply.mockResolvedValue({ ok: true });

      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);

      expect(factory.buildCreateChangeSet).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        expect.objectContaining({ skipOwnershipTxtPrereq: true }),
      );
      expect(transport.apply).toHaveBeenCalled();
    });
  });

  describe('CNAME-vs-A collision pre-detection', () => {
    beforeEach(() => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS: 'dc01.corp.example.com',
              RFC2136_PORT: 53,
              RFC2136_ZONES: 'zone-a.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
              PROJECT_LABEL: 'docker-compose-external-dns',
              INSTANCE_ID: '1',
            }) as Record<string, unknown>
          )[key],
      );
      service.initialize();
      (service as any).pinnedDcForZone.set(
        'zone-a.example.com',
        'dc01.corp.example.com',
      );
      (service as any).availableDcsThisCycle = ['dc01.corp.example.com'];
    });

    it('skips A create when AXFR shows a CNAME at the same name', async () => {
      (service as any).rawAxfrCache.set('zone-a.example.com', [
        {
          name: 'app.zone-a.example.com',
          type: 'CNAME',
          ttl: 300,
          value: 'other.example.com.',
        },
      ]);

      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);
      expect(transport.apply).not.toHaveBeenCalled();
    });

    it('skips CNAME create when AXFR shows any other type at the same name', async () => {
      (service as any).rawAxfrCache.set('zone-a.example.com', [
        {
          name: 'app.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.1',
        },
      ]);

      const { DnsCnameEntry } = await import('../dto/dnscname-entry');
      const entry = Object.assign(new DnsCnameEntry(), {
        name: 'app.zone-a.example.com',
        target: 'other.example.com',
      });
      await service.createEntry(entry);
      expect(transport.apply).not.toHaveBeenCalled();
    });
  });

  describe('domain filter', () => {
    beforeEach(() => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS: 'dc01.corp.example.com',
              RFC2136_PORT: 53,
              RFC2136_ZONES: 'zone-a.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
              RFC2136_DOMAIN_FILTER: 'containers.zone-a.example.com',
              PROJECT_LABEL: 'docker-compose-external-dns',
              INSTANCE_ID: '1',
            }) as Record<string, unknown>
          )[key],
      );
      service.initialize();
      (service as any).pinnedDcForZone.set(
        'zone-a.example.com',
        'dc01.corp.example.com',
      );
      (service as any).availableDcsThisCycle = ['dc01.corp.example.com'];
      factory.buildCreateChangeSet.mockReturnValue({
        prerequisites: [],
        changes: [],
      });
      factory.buildUpdateChangeSet.mockReturnValue({
        prerequisites: [],
        changes: [],
      });
      factory.buildDeleteChangeSet.mockReturnValue({
        prerequisites: [],
        changes: [],
      });
    });

    it('rejects createEntry outside the filter', async () => {
      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'admin.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);
      expect(transport.apply).not.toHaveBeenCalled();
    });

    it('rejects updateEntry outside the filter', async () => {
      const oldRec = new Rfc2136ProviderRecord(
        {
          name: 'admin.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.1',
        },
        'zone-a.example.com',
        { defaultTtl: 3600, minTtl: 60 },
      );
      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const desired = Object.assign(new DnsaEntry(), {
        name: 'admin.zone-a.example.com',
        address: '10.0.0.99',
      });
      await service.updateEntry(oldRec, desired);
      expect(transport.apply).not.toHaveBeenCalled();
    });

    it('rejects deleteEntry outside the filter', async () => {
      const oldRec = new Rfc2136ProviderRecord(
        {
          name: 'admin.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.1',
        },
        'zone-a.example.com',
        { defaultTtl: 3600, minTtl: 60 },
      );
      await service.deleteEntry(oldRec);
      expect(transport.apply).not.toHaveBeenCalled();
    });

    it('filters out records outside the filter in getRecords', async () => {
      (service as any).rawAxfrCache.set('zone-a.example.com', [
        {
          name: 'web.containers.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.1',
        },
        {
          name: 'dnsync-a.web.containers.zone-a.example.com',
          type: 'TXT',
          ttl: 300,
          value: '"owned-by=docker-compose-external-dns:1"',
        },
        {
          name: 'admin.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.0.0.2',
        },
        {
          name: 'dnsync-a.admin.zone-a.example.com',
          type: 'TXT',
          ttl: 300,
          value: '"owned-by=docker-compose-external-dns:1"',
        },
      ]);
      const records = await service.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0].name).toBe('web.containers.zone-a.example.com');
    });

    it('allows createEntry inside the filter', async () => {
      transport.apply.mockResolvedValue({ ok: true });
      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'web.containers.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);
      expect(transport.apply).toHaveBeenCalled();
    });
  });

  describe('TAXFR=false mode', () => {
    beforeEach(() => {
      config.get.mockImplementation(
        (key: string) =>
          (
            ({
              RFC2136_TRANSPORT_URL: 'http://transport:9090',
              RFC2136_AUTH_MODE: 'gss-tsig',
              RFC2136_HOSTS: 'dc01.corp.example.com,dc02.corp.example.com',
              RFC2136_PORT: 53,
              RFC2136_ZONES: 'zone-a.example.com',
              RFC2136_KERBEROS_REALM: 'CORP.EXAMPLE.COM',
              RFC2136_KERBEROS_PRINCIPAL: 'svc-dns@CORP.EXAMPLE.COM',
              RFC2136_KEYTAB_FILE: '/run/secrets/keytab',
              RFC2136_TAXFR: false,
              PROJECT_LABEL: 'docker-compose-external-dns',
              INSTANCE_ID: '1',
            }) as Record<string, unknown>
          )[key],
      );
      service.initialize();
    });

    it('prepareForJob skips AXFR and deterministically pins first available DC', async () => {
      await service.prepareForJob();
      expect(transport.getRecords).not.toHaveBeenCalled();
      expect((service as any).pinnedDcForZone.get('zone-a.example.com')).toBe(
        'dc01.corp.example.com',
      );
    });

    it('getRecords returns [] in TAXFR-off mode', async () => {
      await service.prepareForJob();
      const records = await service.getRecords();
      expect(records).toEqual([]);
    });

    it('createEntry still issues UPDATE using only prereqs (no collision pre-check)', async () => {
      await service.prepareForJob();
      factory.buildCreateChangeSet.mockReturnValue({
        prerequisites: [
          { kind: 'NXRRSET', name: 'app.zone-a.example.com', type: 'A' },
        ],
        changes: [
          {
            op: 'add',
            record: {
              name: 'app.zone-a.example.com',
              type: 'A',
              ttl: 300,
              value: '10.0.0.1',
            },
          },
        ],
      });
      transport.apply.mockResolvedValue({ ok: true });

      const { DnsaEntry } = await import('../dto/dnsa-entry');
      const entry = Object.assign(new DnsaEntry(), {
        name: 'app.zone-a.example.com',
        address: '10.0.0.1',
      });
      await service.createEntry(entry);
      expect(transport.apply).toHaveBeenCalled();
    });
  });
});
