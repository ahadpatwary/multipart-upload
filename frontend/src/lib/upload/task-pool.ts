import { UploadAbortedError, UploadError } from './errors';

export interface PoolResult<T> {
  /** Items whose worker threw a RETRYABLE error after its own retries. Candidates for the next round. */
  failed: Array<{ item: T; error: unknown }>;
}

/**
 * Bounded-concurrency runner: at most `concurrency` workers in flight; a finished worker immediately
 * pulls the next item. One item failing does NOT stop the others (so 63 good parts are never wasted).
 * A NON-retryable error (auth lost, session gone, user abort) stops everything and is re-thrown.
 */
export class TaskPool {
  constructor(private readonly concurrency: number) {
    if (concurrency < 1) throw new RangeError('concurrency must be >= 1');
  }

  async run<T>(items: readonly T[], worker: (item: T) => Promise<void>, signal?: AbortSignal): Promise<PoolResult<T>> {
    const queue = [...items];
    const failed: PoolResult<T>['failed'] = [];
    let fatal: unknown;

    const lane = async (): Promise<void> => {
      while (fatal === undefined) {
        if (signal?.aborted) {
          fatal = new UploadAbortedError();
          return;
        }
        const item = queue.shift();
        if (item === undefined) return;
        try {
          await worker(item);
        } catch (error) {
          const retryable = error instanceof UploadError && error.retryable && !(error instanceof UploadAbortedError);
          if (retryable) failed.push({ item, error });
          else fatal ??= error;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, lane));
    if (fatal !== undefined) throw fatal;
    return { failed };
  }
}
