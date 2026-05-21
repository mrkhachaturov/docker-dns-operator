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
    process.env.RFC2136_KEYTAB_FILE = '/run/secrets/keytab';
    process.env.RFC2136_DEFAULT_TTL = '300';
    process.env.RFC2136_MIN_TTL = '60';
    process.env.PROJECT_LABEL = 'docker-compose-external-dns';
    process.env.INSTANCE_ID = '1';

    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        Rfc2136Service,
        {
          provide: Rfc2136Factory,
          useFactory: () =>
            new Rfc2136Factory({
              ownershipLabel: 'docker-compose-external-dns:1',
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

  it('serializes same-zone writes — second write aborted after first fails', async () => {
    mockState.axfrResponses['dc01.corp.example.com|zone-a.example.com'] = {
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
        message: 'fail',
        retryable: true,
      },
      // The second response must never be consumed; the gate blocks the
      // second create after the first one marks zone-a unhealthy.
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

    await Promise.all([service.createEntry(e1), service.createEntry(e2)]);

    expect(mockState.applyCalls).toHaveLength(1);
    expect(
      (service as any).unhealthyZonesThisCycle.has('zone-a.example.com'),
    ).toBe(true);
  });

  it('does not block writes to a healthy zone when another zone is unhealthy', async () => {
    mockState.axfrResponses['dc01.corp.example.com|zone-a.example.com'] = {
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
        message: 'fail',
        retryable: true,
      }, // zone-a fail
      { ok: true }, // zone-b success
    ];

    const eA = Object.assign(new DnsaEntry(), {
      name: 'x.zone-a.example.com',
      address: '10.0.0.1',
    });
    const eB = Object.assign(new DnsaEntry(), {
      name: 'y.zone-b.example.com',
      address: '10.0.0.2',
    });
    await Promise.all([service.createEntry(eA), service.createEntry(eB)]);

    expect(mockState.applyCalls).toHaveLength(2);
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
          name: 'dnsync-a.app.zone-a.example.com',
          type: 'TXT',
          ttl: 300,
          value: '"owned-by=docker-compose-external-dns:1"',
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
