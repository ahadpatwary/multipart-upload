import { UploadAbortedError, UploadError } from './errors';

export interface RetryPolicyOptions {
  /** Total attempts including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryRunOptions {
  signal?: AbortSignal;
  /** Override per error (e.g. fewer attempts for 403, which usually means a config problem). */
  maxAttemptsFor?: (err: unknown) => number | undefined;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Exponential backoff with FULL jitter: delay = random(0, min(max, base * 2^(attempt-1))).
 * Jitter prevents hundreds of clients retrying in lock-step after a blip.
 * Pure + injectable `random`/`sleep` so it is deterministic in tests.
 */
export class RetryPolicy {
  constructor(
    private readonly options: RetryPolicyOptions,
    private readonly random: () => number = Math.random,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
  ) {}

  delayFor(attempt: number): number {
    const ceiling = Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(this.random() * ceiling);
  }

  async run<T>(fn: (attempt: number) => Promise<T>, run: RetryRunOptions = {}): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt++;
      if (run.signal?.aborted) throw new UploadAbortedError();
      try {
        return await fn(attempt);
      } catch (error) {
        if (error instanceof UploadAbortedError) throw error;
        const retryable = error instanceof UploadError ? error.retryable : false;
        const limit = run.maxAttemptsFor?.(error) ?? this.options.maxAttempts;
        if (!retryable || attempt >= limit) throw error;
        const delayMs = this.delayFor(attempt);
        run.onRetry?.({ attempt, delayMs, error });
        await this.sleep(delayMs, run.signal);
      }
    }
  }
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadAbortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new UploadAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
