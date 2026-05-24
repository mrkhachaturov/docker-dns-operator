import { request } from 'undici';
import {
  Changes,
  DomainFilter,
  Endpoint,
  HealthResponse,
  WEBHOOK_MEDIA_TYPE,
  WebhookResult,
} from './types';

const APPLY_OK_STATUSES = new Set([200, 204]);

function failureFromStatus(status: number): {
  ok: false;
  retryable: boolean;
  status: number;
  message: string;
} {
  return {
    ok: false,
    retryable: status >= 500,
    status,
    message: `webhook HTTP ${status}`,
  };
}

function failureFromError(err: unknown): {
  ok: false;
  retryable: true;
  message: string;
} {
  return {
    ok: false,
    retryable: true,
    message: (err as Error).message,
  };
}

/**
 * HTTP transport for a single webhook sidecar.
 *
 * One client = one sidecar URL. The class is intentionally stateless:
 * the operator-side per-job orchestration (batching, retries across
 * cycles, ownership filtering) belongs in WebhookProvider, not here.
 *
 * Retry semantics are encoded in the returned WebhookResult and follow
 * the external-dns convention: 5xx and network/timeout errors are
 * retryable; 4xx and contract violations (malformed 2xx) are not.
 */
export class WebhookClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly defaultTimeoutMs: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  negotiate(timeoutMs?: number): Promise<WebhookResult<DomainFilter>> {
    return this.getJson<DomainFilter>('/', timeoutMs);
  }

  getRecords(timeoutMs?: number): Promise<WebhookResult<Endpoint[]>> {
    return this.getJson<Endpoint[]>('/records', timeoutMs);
  }

  async applyChanges(
    changes: Changes,
    timeoutMs?: number,
  ): Promise<WebhookResult<void>> {
    const t = timeoutMs ?? this.defaultTimeoutMs;
    try {
      const { statusCode } = await request(`${this.baseUrl}/records`, {
        method: 'POST',
        headers: {
          accept: WEBHOOK_MEDIA_TYPE,
          'content-type': WEBHOOK_MEDIA_TYPE,
        },
        body: JSON.stringify(changes),
        headersTimeout: t,
        bodyTimeout: t,
      });
      if (APPLY_OK_STATUSES.has(statusCode)) {
        return { ok: true, value: undefined };
      }
      return failureFromStatus(statusCode);
    } catch (err) {
      return failureFromError(err);
    }
  }

  health(timeoutMs?: number): Promise<WebhookResult<HealthResponse>> {
    return this.getJson<HealthResponse>('/healthz', timeoutMs);
  }

  private async getJson<T>(
    path: string,
    timeoutMs?: number,
  ): Promise<WebhookResult<T>> {
    const t = timeoutMs ?? this.defaultTimeoutMs;
    try {
      const { statusCode, body } = await request(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { accept: WEBHOOK_MEDIA_TYPE },
        headersTimeout: t,
        bodyTimeout: t,
      });
      if (statusCode < 200 || statusCode >= 300) {
        await body.dump();
        return failureFromStatus(statusCode);
      }
      try {
        const parsed = (await body.json()) as T;
        return { ok: true, value: parsed };
      } catch (parseErr) {
        return {
          ok: false,
          retryable: false,
          status: statusCode,
          message: `malformed JSON in ${statusCode} response: ${
            (parseErr as Error).message
          }`,
        };
      }
    } catch (err) {
      return failureFromError(err);
    }
  }
}
