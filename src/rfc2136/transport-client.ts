import { request } from 'undici';
import {
  ApplyRequest,
  ApplyResponse,
  HealthResponse,
  RecordsRequest,
  RecordsResponse,
} from './types';

export class Rfc2136TransportClient {
  constructor(
    private readonly baseUrl: string,
    private readonly defaultTimeoutMs: number,
  ) {}

  async health(
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<HealthResponse | { ok: false; detail: string }> {
    try {
      const { statusCode, body } = await request(`${this.baseUrl}/healthz`, {
        method: 'GET',
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      if (statusCode !== 200) {
        return { ok: false, detail: `healthz status ${statusCode}` };
      }
      return (await body.json()) as HealthResponse;
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  getRecords(
    req: RecordsRequest,
    timeoutMs?: number,
  ): Promise<RecordsResponse> {
    return this.postJson<RecordsResponse>('/v1/records', req, timeoutMs);
  }

  apply(req: ApplyRequest, timeoutMs?: number): Promise<ApplyResponse> {
    return this.postJson<ApplyResponse>('/v1/apply', req, timeoutMs);
  }

  private async postJson<T extends { ok: boolean }>(
    path: string,
    payload: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const t = timeoutMs ?? this.defaultTimeoutMs;
    try {
      const { statusCode, body } = await request(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        headersTimeout: t,
        bodyTimeout: t,
      });
      if (statusCode >= 500) {
        return {
          ok: false,
          phase: 'dns-send',
          message: `transport HTTP ${statusCode}`,
          retryable: true,
        } as unknown as T;
      }
      if (statusCode >= 400) {
        return {
          ok: false,
          phase: 'dns-send',
          message: `transport HTTP ${statusCode}`,
          retryable: false,
        } as unknown as T;
      }
      return (await body.json()) as T;
    } catch (err) {
      return {
        ok: false,
        phase: 'dns-send',
        message: (err as Error).message,
        retryable: true,
      } as unknown as T;
    }
  }
}
