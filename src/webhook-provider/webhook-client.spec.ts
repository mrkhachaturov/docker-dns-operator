import { MockAgent, setGlobalDispatcher } from 'undici';
import { WebhookClient } from './webhook-client';
import { WEBHOOK_MEDIA_TYPE } from './types';

const BASE = 'http://sidecar:9090';

describe('WebhookClient', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  describe('negotiate (GET /)', () => {
    it('returns the DomainFilter on 200', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/', method: 'GET' })
        .reply(
          200,
          { include: ['example.com'], exclude: ['internal.example.com'] },
          { headers: { 'content-type': WEBHOOK_MEDIA_TYPE } },
        );

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.negotiate();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.include).toEqual(['example.com']);
        expect(result.value.exclude).toEqual(['internal.example.com']);
      }
    });

    it('sends the versioned Accept header — intercept only matches when present', async () => {
      agent
        .get(BASE)
        .intercept({
          path: '/',
          method: 'GET',
          headers: { accept: WEBHOOK_MEDIA_TYPE },
        })
        .reply(200, {}, { headers: { 'content-type': WEBHOOK_MEDIA_TYPE } });

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.negotiate();

      expect(result.ok).toBe(true);
    });

    it('maps 5xx to a retryable failure', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/', method: 'GET' })
        .reply(503, 'unavailable');

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.negotiate();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(true);
        expect(result.status).toBe(503);
      }
    });

    it('maps 4xx to a permanent failure', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/', method: 'GET' })
        .reply(404, 'not found');

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.negotiate();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(false);
        expect(result.status).toBe(404);
      }
    });
  });

  describe('getRecords (GET /records)', () => {
    it('returns the endpoint array on 200', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/records', method: 'GET' })
        .reply(
          200,
          [
            {
              dnsName: 'a.example.com',
              targets: ['10.1.2.3'],
              recordType: 'A',
              recordTTL: 300,
            },
          ],
          { headers: { 'content-type': WEBHOOK_MEDIA_TYPE } },
        );

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.getRecords();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].dnsName).toBe('a.example.com');
        expect(result.value[0].targets).toEqual(['10.1.2.3']);
      }
    });

    it('returns an empty array when the sidecar has no records', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/records', method: 'GET' })
        .reply(200, [], {
          headers: { 'content-type': WEBHOOK_MEDIA_TYPE },
        });

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.getRecords();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([]);
    });

    it('maps 5xx to retryable', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/records', method: 'GET' })
        .reply(502, 'bad gateway');

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.getRecords();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(true);
    });

    it('maps a network error to retryable', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/records', method: 'GET' })
        .replyWithError(new Error('connect ECONNREFUSED'));

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.getRecords();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(true);
        expect(result.message).toContain('ECONNREFUSED');
      }
    });

    it('treats a 2xx with malformed body as a non-retryable contract violation', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/records', method: 'GET' })
        .reply(200, 'not json at all', {
          headers: { 'content-type': 'text/plain' },
        });

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.getRecords();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(false);
        expect(result.status).toBe(200);
      }
    });
  });

  describe('applyChanges (POST /records)', () => {
    it('returns success on 204', async () => {
      agent
        .get(BASE)
        .intercept({
          path: '/records',
          method: 'POST',
          body: (raw) => {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            return (
              Array.isArray(parsed.create) &&
              (parsed.create as unknown[]).length === 1
            );
          },
        })
        .reply(204, '');

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.applyChanges({
        create: [
          {
            dnsName: 'a.example.com',
            targets: ['10.1.2.3'],
            recordType: 'A',
            recordTTL: 300,
          },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it('accepts 200 in addition to 204 (sidecars sometimes return 200)', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/records', method: 'POST' })
        .reply(200, '');

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.applyChanges({ create: [] });
      expect(result.ok).toBe(true);
    });

    it('maps 5xx to retryable', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/records', method: 'POST' })
        .reply(500, 'boom');

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.applyChanges({ create: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(true);
        expect(result.status).toBe(500);
      }
    });

    it('maps 4xx to permanent failure', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/records', method: 'POST' })
        .reply(400, 'invalid payload');

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.applyChanges({ create: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(false);
        expect(result.status).toBe(400);
      }
    });

    it('maps network errors to retryable', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/records', method: 'POST' })
        .replyWithError(new Error('socket hang up'));

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.applyChanges({ create: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(true);
    });
  });

  describe('health (GET /healthz)', () => {
    it('returns the body on 200', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/healthz', method: 'GET' })
        .reply(200, { ok: true, detail: 'ready' });

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.health();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ok).toBe(true);
        expect(result.value.detail).toBe('ready');
      }
    });

    it('treats 503 as a retryable failure (degraded sidecar)', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/healthz', method: 'GET' })
        .reply(503, { ok: false, detail: 'kerberos expired' });

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.health();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(true);
        expect(result.status).toBe(503);
      }
    });

    it('treats network errors as retryable', async () => {
      agent
        .get(BASE)
        .intercept({ path: '/healthz', method: 'GET' })
        .replyWithError(new Error('ETIMEDOUT'));

      const client = new WebhookClient(BASE, 30_000);
      const result = await client.health();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(true);
    });
  });

  describe('baseUrl normalization', () => {
    it('handles a trailing slash on baseUrl', async () => {
      agent
        .get('http://sidecar:9090')
        .intercept({ path: '/records', method: 'GET' })
        .reply(200, [], {
          headers: { 'content-type': WEBHOOK_MEDIA_TYPE },
        });

      const client = new WebhookClient('http://sidecar:9090/', 30_000);
      const result = await client.getRecords();
      expect(result.ok).toBe(true);
    });
  });
});
