/**
 * Full provider e2e for Rfc2136Service against an in-process mock sidecar.
 *
 * Exercises the public IDnsProvider surface and covers:
 *   - DC pinning when one DC serves both zones
 *   - Per-zone failover when DC1 cannot serve one of the zones
 *   - Per-zone serialization queue: second write to a now-unhealthy zone is gated out
 *   - Cross-zone isolation: a failing zone does not block writes to a healthy zone
 *   - getRecords filtering: only records with matching ownership TXTs are surfaced,
 *     ownership TXTs themselves are not surfaced, and unowned records are excluded
 */
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ConsoleLoggerService } from '../src/logger.service';
import { Rfc2136Service } from '../src/rfc2136/rfc2136.service';
import { Rfc2136Factory } from '../src/rfc2136/rfc2136.factory';
import { Rfc2136TransportClient } from '../src/rfc2136/transport-client';
import { DnsaEntry } from '../src/dto/dnsa-entry';
import { DNSTypes } from '../src/dto/dnsbase-entry';

interface MockState {
  axfrResponses: Record<string, any>; // keyed by `${host}|${zone}`
  applyResponses: any[]; // FIFO queue
  applyCalls: any[];
}

function makeMockSidecar(
  state: MockState,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const json = body ? JSON.parse(body) : null;
        res.setHeader('content-type', 'application/json');
        if (req.url === '/healthz') {
          res.end(JSON.stringify({ ok: true, kerberos: 'ready', detail: '' }));
          return;
        }
        if (req.url === '/v1/records') {
          const key = `${json.host}|${json.zone}`;
          const r = state.axfrResponses[key] ?? {
            ok: false,
            phase: 'dns-send',
            message: 'no mock',
            retryable: false,
          };
          res.end(JSON.stringify(r));
          return;
        }
        if (req.url === '/v1/apply') {
          state.applyCalls.push(json);
          const r = state.applyResponses.shift() ?? { ok: true };
          res.end(JSON.stringify(r));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('Rfc2136Service e2e', () => {
  let module: TestingModule;
  let service: Rfc2136Service;
  let mockSidecar: { server: Server; url: string };
  let mockState: MockState;

  beforeEach(async () => {
    mockState = { axfrResponses: {}, applyResponses: [], applyCalls: [] };
    mockSidecar = await makeMockSidecar(mockState);

    process.env.RFC2136_TRANSPORT_URL = mockSidecar.url;
    process.env.RFC2136_AUTH_MODE = 'gss-tsig';
    process.env.RFC2136_HOSTS = 'dc01.corp.example.com,dc02.corp.example.com';
    process.env.RFC2136_PORT = '53';
    process.env.RFC2136_ZONES = 'zone-a.example.com,zone-b.example.com';
    process.env.RFC2136_KERBEROS_REALM = 'CORP.EXAMPLE.COM';
    process.env.RFC2136_KERBEROS_PRINCIPAL = 'svc-dns@CORP.EXAMPLE.COM';
    process.env.RFC2136_DEFAULT_TTL = '300';
    process.env.RFC2136_MIN_TTL = '60';
    process.env.PROJECT_LABEL = 'docker-dns-operator';
    process.env.INSTANCE_ID = '1';

    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        Rfc2136Service,
        {
          provide: Rfc2136Factory,
          useFactory: () =>
            new Rfc2136Factory({
              ownershipLabel: 'docker-dns-operator:1',
              defaultTtl: 300,
              minTtl: 60,
            }),
        },
        {
          provide: Rfc2136TransportClient,
          useFactory: () => new Rfc2136TransportClient(mockSidecar.url, 5000),
        },
        {
          provide: ConsoleLoggerService,
          useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(Rfc2136Service);
    service.initialize();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      mockSidecar.server.close(() => resolve());
    });
  });

  it('pins DC1 for both zones when DC1 serves both AXFRs', async () => {
    mockState.axfrResponses['dc01.corp.example.com|zone-a.example.com'] = {
      ok: true,
      records: [],
    };
    mockState.axfrResponses['dc01.corp.example.com|zone-b.example.com'] = {
      ok: true,
      records: [],
    };

    await service.prepareForJob();
    expect((service as any).pinnedDcForZone.get('zone-a.example.com')).toBe(
      'dc01.corp.example.com',
    );
    expect((service as any).pinnedDcForZone.get('zone-b.example.com')).toBe(
      'dc01.corp.example.com',
    );
  });

  it('falls over to DC2 only for the zone DC1 cannot serve', async () => {
    mockState.axfrResponses['dc01.corp.example.com|zone-a.example.com'] = {
      ok: true,
      records: [],
    };
    mockState.axfrResponses['dc01.corp.example.com|zone-b.example.com'] = {
      ok: false,
      phase: 'dns-send',
      message: 'timeout',
      retryable: true,
    };
    mockState.axfrResponses['dc02.corp.example.com|zone-b.example.com'] = {
      ok: true,
      records: [],
    };

    await service.prepareForJob();
    expect((service as any).pinnedDcForZone.get('zone-a.example.com')).toBe(
      'dc01.corp.example.com',
    );
    expect((service as any).pinnedDcForZone.get('zone-b.example.com')).toBe(
      'dc02.corp.example.com',
    );
  });

  it('fails over to DC2 on retryable apply failure; re-pins zone to the new DC', async () => {
    // Both DCs serve AXFR for zone-a so failover is available.
    mockState.axfrResponses['dc01.corp.example.com|zone-a.example.com'] = {
      ok: true,
      records: [],
    };
    mockState.axfrResponses['dc02.corp.example.com|zone-a.example.com'] = {
      ok: true,
      records: [],
    };
    mockState.axfrResponses['dc01.corp.example.com|zone-b.example.com'] = {
      ok: true,
      records: [],
    };
    await service.prepareForJob();
    // After prepareForJob, zone-a pins DC1 (first-success-wins). Confirm.
    expect((service as any).pinnedDcForZone.get('zone-a.example.com')).toBe(
      'dc01.corp.example.com',
    );

    mockState.applyResponses = [
      {
        ok: false,
        rcode: 'SERVFAIL',
        phase: 'dns-receive',
        message: 'fail',
        retryable: true,
      }, // DC1 fails first create
      { ok: true }, // DC2 succeeds on failover for first create
      { ok: true }, // DC2 succeeds on second create (zone now pinned to DC2)
    ];

    const e1 = Object.assign(new DnsaEntry(), {
      name: 'first.zone-a.example.com',
      address: '10.0.0.1',
    });
    const e2 = Object.assign(new DnsaEntry(), {
      name: 'second.zone-a.example.com',
      address: '10.0.0.2',
    });

    await service.createEntry(e1);
    await service.createEntry(e2);

    expect(mockState.applyCalls).toHaveLength(3);
    expect(mockState.applyCalls[0].host).toBe('dc01.corp.example.com');
    expect(mockState.applyCalls[1].host).toBe('dc02.corp.example.com');
    expect(mockState.applyCalls[2].host).toBe('dc02.corp.example.com');
    expect(
      (service as any).unhealthyZonesThisCycle.has('zone-a.example.com'),
    ).toBe(false);
    expect((service as any).pinnedDcForZone.get('zone-a.example.com')).toBe(
      'dc02.corp.example.com',
    );
  });

  it('marks zone unhealthy only after ALL DCs exhausted; gates subsequent same-zone writes', async () => {
    mockState.axfrResponses['dc01.corp.example.com|zone-a.example.com'] = {
      ok: true,
      records: [],
    };
    mockState.axfrResponses['dc02.corp.example.com|zone-a.example.com'] = {
      ok: true,
      records: [],
    };
    mockState.axfrResponses['dc01.corp.example.com|zone-b.example.com'] = {
      ok: true,
      records: [],
    };
    await service.prepareForJob();

    mockState.applyResponses = [
      {
        ok: false,
        rcode: 'SERVFAIL',
        phase: 'dns-receive',
        message: 'dc1 fail',
        retryable: true,
      },
      {
        ok: false,
        rcode: 'SERVFAIL',
        phase: 'dns-receive',
        message: 'dc2 fail',
        retryable: true,
      },
      // Third response must never be consumed — zone is now unhealthy, second
      // create is gated out by the ZoneQueue.
      { ok: true },
    ];

    const e1 = Object.assign(new DnsaEntry(), {
      name: 'first.zone-a.example.com',
      address: '10.0.0.1',
    });
    const e2 = Object.assign(new DnsaEntry(), {
      name: 'second.zone-a.example.com',
      address: '10.0.0.2',
    });

    await service.createEntry(e1);
    await service.createEntry(e2);

    expect(mockState.applyCalls).toHaveLength(2);
    expect(
      (service as any).unhealthyZonesThisCycle.has('zone-a.example.com'),
    ).toBe(true);
  });

  it('isolated zone health: a fully-failed zone does not block writes to another zone', async () => {
    mockState.axfrResponses['dc01.corp.example.com|zone-a.example.com'] = {
      ok: true,
      records: [],
    };
    mockState.axfrResponses['dc02.corp.example.com|zone-a.example.com'] = {
      ok: true,
      records: [],
    };
    mockState.axfrResponses['dc01.corp.example.com|zone-b.example.com'] = {
      ok: true,
      records: [],
    };
    await service.prepareForJob();

    mockState.applyResponses = [
      // zone-a both DCs fail
      {
        ok: false,
        rcode: 'SERVFAIL',
        phase: 'dns-receive',
        message: 'dc1',
        retryable: true,
      },
      {
        ok: false,
        rcode: 'SERVFAIL',
        phase: 'dns-receive',
        message: 'dc2',
        retryable: true,
      },
      // zone-b first DC succeeds
      { ok: true },
    ];

    const eA = Object.assign(new DnsaEntry(), {
      name: 'x.zone-a.example.com',
      address: '10.0.0.1',
    });
    const eB = Object.assign(new DnsaEntry(), {
      name: 'y.zone-b.example.com',
      address: '10.0.0.2',
    });
    // Sequential to keep mock-response order deterministic.
    await service.createEntry(eA);
    await service.createEntry(eB);

    expect(mockState.applyCalls).toHaveLength(3);
    expect(
      (service as any).unhealthyZonesThisCycle.has('zone-a.example.com'),
    ).toBe(true);
    expect(
      (service as any).unhealthyZonesThisCycle.has('zone-b.example.com'),
    ).toBe(false);
  });

  it('returns owned records via getRecords and excludes ownership TXTs', async () => {
    mockState.axfrResponses['dc01.corp.example.com|zone-a.example.com'] = {
      ok: true,
      records: [
        {
          name: 'app.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.1.2.3',
        },
        {
          name: 'ddo-a.app.zone-a.example.com',
          type: 'TXT',
          ttl: 300,
          value: '"owned-by=docker-dns-operator:1"',
        },
        {
          name: 'unowned.zone-a.example.com',
          type: 'A',
          ttl: 300,
          value: '10.9.9.9',
        },
      ],
    };
    mockState.axfrResponses['dc01.corp.example.com|zone-b.example.com'] = {
      ok: true,
      records: [],
    };

    await service.prepareForJob();
    const records = await service.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('app.zone-a.example.com');
    expect(records[0].type).toBe(DNSTypes.A);
  });
});
