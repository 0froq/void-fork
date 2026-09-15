import { cfAccessHeaders } from '../shared/cf-access.ts';
import { normalizePlatformApiUrl } from './platform-registry.ts';

export class OperatorClientError extends Error {
  constructor(
    message: string,
    public readonly code = 'operator_error',
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OperatorClientError';
  }
  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export class OperatorClient {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.origin = normalizePlatformApiUrl(origin);
  }
  async request(
    path: string,
    options: {
      method?: 'GET' | 'POST';
      query?: Record<string, string>;
      body?: Record<string, unknown>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('?') ||
      path.includes('#')
    ) {
      throw new OperatorClientError('Invalid operator API path.');
    }
    const url = new URL(`${this.origin}/operator/v1${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        headers: {
          ...cfAccessHeaders(process.env, this.origin),
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      throw new OperatorClientError(
        `Operator request to ${this.origin} failed. ${options.method === 'POST' ? 'Its outcome may be unknown; inspect platform state before retrying.' : 'Check connectivity and try again.'}`,
        'connection_failed',
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new OperatorClientError(
        'The operator API redirected the request. Credentials were not forwarded; use the exact platform API origin.',
        'redirect_rejected',
        response.status,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new OperatorClientError(
        `Operator API returned invalid JSON (HTTP ${response.status}).${options.method === 'POST' ? ' Inspect platform state before retrying.' : ''}`,
        'invalid_response',
        response.status,
      );
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new OperatorClientError(
        'Operator API returned an invalid response object.',
        'invalid_response',
        response.status,
      );
    }
    const result = data as Record<string, unknown>;
    if (!response.ok) {
      throw new OperatorClientError(
        typeof result.message === 'string'
          ? result.message
          : `Operator request failed (HTTP ${response.status}).`,
        typeof result.error === 'string' ? result.error : 'request_failed',
        response.status,
        result.details,
      );
    }
    if (result.partial === true || result.ok === false) {
      throw new OperatorClientError(
        'The operation did not fully complete. Inspect the partial result before retrying.',
        'partial_failure',
        response.status,
        result,
      );
    }
    return result;
  }
}
