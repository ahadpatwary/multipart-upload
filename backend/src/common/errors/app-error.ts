/**
 * Every expected failure is an AppError with a stable machine-readable `code`.
 * The client branches on `code` + `retryable`, never on message text.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly retryable: boolean = false;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationFailedError extends AppError {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;
}

export class UnauthorizedError extends AppError {
  readonly code = 'UNAUTHORIZED';
  readonly httpStatus = 401;
}

/** Also used for "exists but not yours" so we never leak other users' session ids. */
export class SessionNotFoundError extends AppError {
  readonly code = 'UPLOAD_NOT_FOUND';
  readonly httpStatus = 404;
  constructor() {
    super('Upload session not found');
  }
}

export class SessionExpiredError extends AppError {
  readonly code = 'UPLOAD_EXPIRED';
  readonly httpStatus = 410;
  constructor(message = 'Upload session expired or was aborted; start a new upload') {
    super(message);
  }
}

export class QuotaExceededError extends AppError {
  readonly code = 'QUOTA_EXCEEDED';
  readonly httpStatus = 422;
  constructor(details?: Record<string, unknown>) {
    super('Storage quota exceeded', details);
  }
}

export class TooManyActiveUploadsError extends AppError {
  readonly code = 'TOO_MANY_ACTIVE_UPLOADS';
  readonly httpStatus = 429;
  constructor(limit: number) {
    super(`You can have at most ${limit} active uploads`, { limit });
  }
}

export class InvalidStateError extends AppError {
  readonly code = 'INVALID_STATE';
  readonly httpStatus = 409;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class IdempotencyConflictError extends AppError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly httpStatus = 422;
  constructor() {
    super('Idempotency-Key was already used with a different request');
  }
}

/** Another request is already driving this transition. Safe to retry shortly. */
export class OperationInProgressError extends AppError {
  readonly code = 'OPERATION_IN_PROGRESS';
  readonly httpStatus = 409;
  override readonly retryable = true;
  constructor(message = 'Another request is already processing this upload; retry shortly') {
    super(message);
  }
}

/** Complete was requested but S3 does not have all (valid) parts. Client re-uploads ONLY these parts. */
export class PartsMissingError extends AppError {
  readonly code = 'PARTS_MISSING';
  readonly httpStatus = 409;
  override readonly retryable = true;
  constructor(missingParts: number[], invalidParts: number[]) {
    super('Some parts are missing or have an unexpected size', { missingParts, invalidParts });
  }
}

export class IntegrityError extends AppError {
  readonly code = 'INTEGRITY_CHECK_FAILED';
  readonly httpStatus = 422;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** S3 reports the multipart upload no longer exists (aborted / lifecycle-expired / completed). */
export class StorageUploadMissingError extends AppError {
  readonly code = 'STORAGE_UPLOAD_MISSING';
  readonly httpStatus = 410;
  constructor(cause?: unknown) {
    super('The storage-side multipart upload no longer exists', undefined, { cause });
  }
}

export class StorageError extends AppError {
  readonly code = 'STORAGE_ERROR';
  readonly httpStatus = 502;
  override readonly retryable: boolean;
  constructor(operation: string, retryable: boolean, cause?: unknown) {
    super(`Storage operation failed: ${operation}`, { operation }, { cause });
    this.retryable = retryable;
  }
}
