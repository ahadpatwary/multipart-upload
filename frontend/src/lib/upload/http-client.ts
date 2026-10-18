import 'reflect-metadata';
import { inject, injectable } from 'tsyringe';
import { ApiError, NetworkError, UploadAbortedError } from './errors';
import { UPLOAD_TOKENS, type AuthTokenProvider } from './tokens';

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/** Control-plane HTTP: auth header, JSON, and translation of every failure into an UploadError subtype. */
@injectable()
export class HttpClient {
  constructor(
    @inject(UPLOAD_TOKENS.ApiBaseUrl) private readonly baseUrl: string,
    @inject(UPLOAD_TOKENS.AuthTokenProvider) private readonly auth: AuthTokenProvider,
  ) {}

  async request<T>(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<T> {
    const token = await this.auth.getToken();

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          authorization: `Bearer ${token}`,
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch (err) {
      if (isAbortError(err) || opts.signal?.aborted) throw new UploadAbortedError();
      throw new NetworkError('Could not reach the server', err);
    }

    const text = await res.text().catch(() => '');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (res.ok) {
      if (json === undefined) throw new ApiError('Empty or invalid server response', 'BAD_RESPONSE', true, res.status);
      return json as T;
    }

    const envelope = (json as ErrorEnvelope | undefined)?.error;
    if (envelope?.code) {
      throw new ApiError(
        envelope.message ?? 'Request failed',
        envelope.code,
        Boolean(envelope.retryable),
        res.status,
        envelope.requestId,
        envelope.details,
      );
    }
    // Non-JSON failure (gateway/proxy page, etc.)
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new ApiError(`Server responded with ${res.status}`, `HTTP_${res.status}`, retryable, res.status);
  }
}
