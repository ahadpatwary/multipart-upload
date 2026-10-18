import 'reflect-metadata';
import { inject, injectable } from 'tsyringe';
import { ApiError } from './errors';
import { HttpClient } from './http-client';
import { RetryPolicy } from './retry-policy';
import { UPLOAD_TOKENS } from './tokens';
import type { InitiateRequest, PresignedPart, UploadedPart, UploadSessionView } from './types';

/** Typed client for the 5 backend endpoints. Control-plane calls get their own (lighter) retry policy. */
@injectable()
export class UploadApi {
  constructor(
    @inject(HttpClient) private readonly http: HttpClient,
    @inject(UPLOAD_TOKENS.ApiRetryPolicy) private readonly retry: RetryPolicy,
  ) {}

  /** Safe to retry blindly: the Idempotency-Key makes the server return the same session. */
  initiate(
    body: InitiateRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<{ session: UploadSessionView; resumed: boolean }> {
    return this.retry.run(
      () => this.http.request('POST', '/uploads', { body, headers: { 'idempotency-key': idempotencyKey }, signal }),
      { signal },
    );
  }

  getStatus(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ session: UploadSessionView; uploadedParts: UploadedPart[] }> {
    return this.retry.run(() => this.http.request('GET', `/uploads/${id}`, { signal }), { signal });
  }

  async presign(id: string, partNumbers: number[], signal?: AbortSignal): Promise<PresignedPart[]> {
    const res = await this.retry.run(
      () =>
        this.http.request<{ urls: PresignedPart[] }>('POST', `/uploads/${id}/parts/presign`, {
          body: { partNumbers },
          signal,
        }),
      { signal },
    );
    return res.urls;
  }

  async complete(id: string, signal?: AbortSignal): Promise<UploadSessionView> {
    const res = await this.retry.run(
      () => this.http.request<{ session: UploadSessionView }>('POST', `/uploads/${id}/complete`, { signal }),
      {
        signal,
        // PARTS_MISSING is "retryable" only AFTER re-uploading those parts: the engine handles it, not a blind retry.
        maxAttemptsFor: (e) => (e instanceof ApiError && e.code === 'PARTS_MISSING' ? 1 : undefined),
      },
    );
    return res.session;
  }

  async abort(id: string, signal?: AbortSignal): Promise<void> {
    await this.retry.run(() => this.http.request('POST', `/uploads/${id}/abort`, { signal }), { signal });
  }
}
