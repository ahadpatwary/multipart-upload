/** Every failure the client can see is an UploadError with a stable `code` and an explicit `retryable` flag. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'UploadError';
  }
}

/** Error returned by our API (parsed from the JSON error envelope). */
export class ApiError extends UploadError {
  constructor(
    message: string,
    code: string,
    retryable: boolean,
    readonly status: number,
    readonly requestId?: string,
    details?: Record<string, unknown>,
  ) {
    super(message, code, retryable, details);
    this.name = 'ApiError';
  }
}

/** Connection reset, DNS failure, offline, CORS-blocked preflight… no HTTP status available. */
export class NetworkError extends UploadError {
  constructor(message = 'Network error', cause?: unknown) {
    super(message, 'NETWORK_ERROR', true, undefined, { cause });
    this.name = 'NetworkError';
  }
}

export class PartUploadError extends UploadError {
  constructor(
    message: string,
    code: string,
    retryable: boolean,
    readonly partNumber: number,
    readonly status?: number,
  ) {
    super(message, code, retryable);
    this.name = 'PartUploadError';
  }
}

/** Thrown when the user paused/cancelled. Never retried, never shown as a failure. */
export class UploadAbortedError extends UploadError {
  constructor() {
    super('Upload aborted', 'ABORTED', false);
    this.name = 'UploadAbortedError';
  }
}

export function isAbort(err: unknown): boolean {
  return err instanceof UploadAbortedError;
}

export function toPlainError(err: unknown): { code: string; message: string; retryable: boolean } {
  if (err instanceof UploadError) return { code: err.code, message: err.message, retryable: err.retryable };
  return { code: 'UNKNOWN', message: err instanceof Error ? err.message : 'Unknown error', retryable: false };
}
