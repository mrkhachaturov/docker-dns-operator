import { MockAgent, setGlobalDispatcher } from 'undici';
import { Rfc2136TransportClient } from './transport-client';

describe('Rfc2136TransportClient', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  it('returns records on ok response', async () => {
    agent
      .get('http://transport:9090')
      .intercept({ path: '/v1/records', method: 'POST' })
      .reply(200, {
        ok: true,
        records: [
          { name: 'a.example.com', type: 'A', ttl: 300, value: '10.1.2.3' },
        ],
      });

    const client = new Rfc2136TransportClient('http://transport:9090', 30_000);
    const result = await client.getRecords({
      host: 'dc01.corp.example.com',
      port: 53,
      zone: 'example.com',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.records).toHaveLength(1);
  });

  it('returns a typed failure on ok:false response', async () => {
    agent
      .get('http://transport:9090')
      .intercept({ path: '/v1/records', method: 'POST' })
      .reply(200, {
        ok: false,
        phase: 'tsig-verify',
        message: 'bad signature',
        retryable: false,
      });

    const client = new Rfc2136TransportClient('http://transport:9090', 30_000);
    const result = await client.getRecords({
      host: 'dc01.corp.example.com',
      port: 53,
      zone: 'example.com',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.phase).toBe('tsig-verify');
      expect(result.retryable).toBe(false);
    }
  });

  it('maps a non-200 HTTP status to a retryable failure', async () => {
    agent
      .get('http://transport:9090')
      .intercept({ path: '/v1/records', method: 'POST' })
      .reply(503, 'service unavailable');

    const client = new Rfc2136TransportClient('http://transport:9090', 30_000);
    const result = await client.getRecords({
      host: 'dc01.corp.example.com',
      port: 53,
      zone: 'example.com',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.phase).toBe('dns-send');
    }
  });

  it('maps a network timeout to a retryable failure', async () => {
    agent
      .get('http://transport:9090')
      .intercept({ path: '/v1/records', method: 'POST' })
      .replyWithError(new Error('connect ETIMEDOUT'));

    const client = new Rfc2136TransportClient('http://transport:9090', 30_000);
    const result = await client.getRecords({
      host: 'dc01.corp.example.com',
      port: 53,
      zone: 'example.com',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });
});
