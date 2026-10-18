import 'reflect-metadata';
import { injectable } from 'tsyringe';
import { NetworkError, PartUploadError, UploadAbortedError } from './errors';

export interface PutPartOptions {
  partNumber: number;
  signal?: AbortSignal;
  /** Abort the request if NO bytes move for this long (a total timeout would punish slow-but-healthy links). */
  stallTimeoutMs?: number;
  onProgress?: (loadedBytes: number) => void;
}

const RETRYABLE_S3_CODES = ['RequestTimeout', 'SlowDown', 'InternalError', 'ServiceUnavailable'];

/**
 * Data-plane: PUT one chunk straight to S3 via XHR (fetch has no upload progress events).
 * Resolves only on a 2xx. Every failure is classified as retryable or not.
 */
@injectable()
export class PartUploader {
  put(url: string, body: Blob, opts: PutPartOptions): Promise<void> {
    const { partNumber, signal, onProgress } = opts;
    const stallTimeoutMs = opts.stallTimeoutMs ?? 60_000;

    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new UploadAbortedError());

      const xhr = new XMLHttpRequest();
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const cleanup = () => {
        if (stallTimer) clearTimeout(stallTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const armStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          xhr.abort();
          settle(() => reject(new PartUploadError('Upload stalled (no progress)', 'PART_STALLED', true, partNumber)));
        }, stallTimeoutMs);
      };
      const onAbort = () => {
        xhr.abort();
        settle(() => reject(new UploadAbortedError()));
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      xhr.open('PUT', url);
      xhr.upload.onprogress = (e) => {
        armStallTimer();
        onProgress?.(e.loaded);
      };
      xhr.onload = () => {
        const s = xhr.status;
        if (s >= 200 && s < 300) {
          onProgress?.(body.size);
          return settle(resolve);
        }
        settle(() => reject(this.classify(s, xhr.responseText, partNumber)));
      };
      xhr.onerror = () => settle(() => reject(new NetworkError(`Network error uploading part ${partNumber}`)));
      xhr.ontimeout = () =>
        settle(() => reject(new PartUploadError('Part upload timed out', 'PART_TIMEOUT', true, partNumber)));
      xhr.onabort = () => settle(() => reject(signal?.aborted ? new UploadAbortedError() : new NetworkError('aborted')));

      armStallTimer();
      xhr.send(body);
    });
  }

  private classify(status: number, responseText: string, partNumber: number): PartUploadError {
    // Browser can read the XML body when CORS allows the origin; it names the exact S3 error.
    const s3Retryable = RETRYABLE_S3_CODES.some((c) => responseText.includes(`<Code>${c}</Code>`));
    if (responseText.includes('<Code>NoSuchUpload</Code>') || status === 404) {
      return new PartUploadError('Upload session no longer exists on storage', 'PART_UPLOAD_GONE', false, partNumber, status);
    }
    if (status === 403) {
      // Expired/invalid signature (or clock skew / CORS / IAM misconfig). A fresh URL fixes the first; the engine caps attempts.
      return new PartUploadError('Upload URL rejected (expired or invalid)', 'PART_FORBIDDEN', true, partNumber, status);
    }
    const retryable = status >= 500 || status === 408 || status === 429 || s3Retryable;
    return new PartUploadError(`Storage rejected part ${partNumber} (HTTP ${status})`, `PART_HTTP_${status}`, retryable, partNumber, status);
  }
}
