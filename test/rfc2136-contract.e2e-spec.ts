/**
 * Contract test pinning the JSON shape that the NestJS provider expects from
 * the rfc2136 sidecar. If the sidecar is ever reimplemented in a different
 * language or swapped for an alternate transport, these assertions must still
 * hold — they are the protocol contract.
 */
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { Rfc2136WebhookClient } from '../src/rfc2136/webhook-client';

describe('rfc2136 sidecar contract', () => {
  let server: Server;
  let url: string;
  let lastBody: any;
  let nextResponse: any = { ok: true, records: [] };

  beforeAll((done) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          lastBody = body ? JSON.parse(body) : null;
        } catch {
          lastBody = body;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(nextResponse));
      });
    }).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      url = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  it('POST /v1/records request shape', async () => {
    nextResponse = {
      ok: true,
      records: [
        { name: 'a.example.com', type: 'A', ttl: 300, value: '10.0.0.1' },
      ],
    };
    const client = new Rfc2136WebhookClient(url, 5000);
    const res = await client.getRecords({
      host: 'dc01.corp.example.com',
      port: 53,
      zone: 'example.com',
    });
    expect(lastBody).toEqual({
      host: 'dc01.corp.example.com',
      port: 53,
      zone: 'example.com',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.records[0]).toMatchObject({
        name: 'a.example.com',
        type: 'A',
      });
    }
  });

  it('POST /v1/apply request shape includes prereqs and changes verbatim', async () => {
    nextResponse = { ok: true };
    const client = new Rfc2136WebhookClient(url, 5000);
    await client.apply({
      host: 'dc01.corp.example.com',
      port: 53,
      zone: 'example.com',
      prerequisites: [{ kind: 'NXRRSET', name: 'app.example.com', type: 'A' }],
      changes: [
        {
          op: 'add',
          record: {
            name: 'app.example.com',
            type: 'A',
            ttl: 300,
            value: '10.0.0.1',
          },
        },
      ],
    });
    expect(lastBody.prerequisites).toEqual([
      { kind: 'NXRRSET', name: 'app.example.com', type: 'A' },
    ]);
    expect(lastBody.changes).toHaveLength(1);
    expect(lastBody.changes[0]).toEqual({
      op: 'add',
      record: {
        name: 'app.example.com',
        type: 'A',
        ttl: 300,
        value: '10.0.0.1',
      },
    });
  });

  it('decodes a typed failure response', async () => {
    nextResponse = {
      ok: false,
      rcode: 'YXRRSET',
      phase: 'dns-receive',
      message: 'prereq failed',
      retryable: false,
    };
    const client = new Rfc2136WebhookClient(url, 5000);
    const res = await client.apply({
      host: 'dc01.corp.example.com',
      port: 53,
      zone: 'example.com',
      prerequisites: [],
      changes: [],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rcode).toBe('YXRRSET');
      expect(res.phase).toBe('dns-receive');
      expect(res.retryable).toBe(false);
    }
  });
});
