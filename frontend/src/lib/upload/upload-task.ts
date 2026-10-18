import { ApiError, PartUploadError, UploadAbortedError, UploadError, isAbort, toPlainError } from './errors';
import { PartPlan } from './part-plan';
import type { PartUploader } from './part-uploader';
import type { ResumeStore } from './resume-store';
import type { RetryPolicy } from './retry-policy';
import { TaskPool } from './task-pool';
import type { UploadApi } from './upload-api';
import type { TaskState, UploadOptions, UploadProgress, UploadSessionView } from './types';

export interface UploadTaskDeps {
  api: UploadApi;
  uploader: PartUploader;
  store: ResumeStore;
  partRetry: RetryPolicy;
  newId?: () => string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined); // failures are surfaced via state/progress; avoid unhandled-rejection noise
  return { promise, resolve, reject };
}

/**
 * One file upload. Lifecycle: start → (pause/resume)* → completed | failed | cancelled.
 *
 * Correctness model:
 *   - The SERVER (via S3 ListParts) is the source of truth for which parts exist.
 *   - Each round: sync status → upload ONLY missing parts → try complete.
 *   - If complete says PARTS_MISSING, loop again: only those parts are re-sent.
 */
export class UploadTask {
  private state: TaskState = 'idle';
  private controller = new AbortController();
  private intent: 'none' | 'pause' | 'cancel' = 'none';
  private running = false;
  private done_ = deferred<UploadSessionView>();

  private session: UploadSessionView | null = null;
  private plan: PartPlan | null = null;
  private readonly confirmed = new Map<number, number>(); // partNumber -> bytes confirmed by server/S3
  private readonly inflight = new Map<number, number>(); // partNumber -> bytes sent so far this attempt
  private retrying: number[] = [];
  private error: UploadProgress['error'] = null;

  private speed = 0;
  private lastSample = { t: 0, bytes: 0 };
  private lastEmit = 0;
  private readonly listeners = new Set<(p: UploadProgress) => void>();

  private readonly concurrency: number;
  private readonly maxRounds: number;
  private readonly fingerprint: string;

  constructor(
    private readonly file: File,
    private readonly deps: UploadTaskDeps,
    private readonly options: UploadOptions = {},
    fingerprint: string,
  ) {
    this.concurrency = options.concurrency ?? 4;
    this.maxRounds = options.maxRounds ?? 3;
    this.fingerprint = fingerprint;
    if (options.onProgress) this.listeners.add(options.onProgress);
  }

  // ───────────── public API ─────────────

  /** Resolves when the upload is COMPLETED; rejects on failure/cancel. Pausing keeps it pending. */
  start(): Promise<UploadSessionView> {
    if (this.state !== 'idle') return this.done_.promise;
    this.launch();
    return this.done_.promise;
  }

  pause(): void {
    if (!this.running) return;
    this.intent = 'pause';
    this.controller.abort();
  }

  /** Continue after pause, or retry after a failure (already-uploaded parts are skipped). */
  resume(): Promise<UploadSessionView> {
    if (this.state === 'failed') this.done_ = deferred<UploadSessionView>();
    else if (this.state !== 'paused') return this.done_.promise;
    this.error = null;
    this.launch();
    return this.done_.promise;
  }

  async cancel(): Promise<void> {
    const wasRunning = this.running;
    this.intent = 'cancel';
    this.controller.abort();
    if (!wasRunning) await this.finishCancel(); // paused/failed/idle: nothing in flight to unwind
  }

  subscribe(listener: (p: UploadProgress) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): UploadProgress {
    const total = this.file.size;
    let uploaded = 0;
    for (const b of this.confirmed.values()) uploaded += b;
    for (const [n, b] of this.inflight) if (!this.confirmed.has(n)) uploaded += b;
    uploaded = Math.min(uploaded, total);
    const remaining = total - uploaded;
    return {
      state: this.state,
      totalBytes: total,
      uploadedBytes: uploaded,
      percent: total === 0 ? 0 : Math.floor((uploaded / total) * 1000) / 10,
      partsDone: this.confirmed.size,
      partCount: this.plan?.partCount ?? 0,
      activeParts: this.inflight.size,
      retryingParts: [...this.retrying],
      speedBytesPerSec: Math.round(this.speed),
      etaSeconds: this.speed > 1024 && this.state === 'uploading' ? Math.ceil(remaining / this.speed) : null,
      error: this.error,
    };
  }

  // ───────────── internals ─────────────

  private launch(): void {
    this.intent = 'none';
    this.controller = new AbortController();
    this.running = true;
    this.speed = 0;
    this.lastSample = { t: performance.now(), bytes: this.snapshot().uploadedBytes };
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const view = await this.execute();
      this.running = false;
      this.deps.store.clear(this.fingerprint);
      this.setState('completed', true);
      this.done_.resolve(view);
    } catch (err) {
      this.running = false;
      this.inflight.clear();
      if (isAbort(err)) {
        if (this.intent === 'pause') return void this.setState('paused', true);
        return void (await this.finishCancel());
      }
      // Session is dead on the server (expired/aborted): forget it so a retry starts clean.
      if (err instanceof ApiError && ['UPLOAD_EXPIRED', 'UPLOAD_NOT_FOUND'].includes(err.code)) {
        this.deps.store.clear(this.fingerprint);
      }
      this.error = toPlainError(err);
      this.setState('failed', true);
      this.done_.reject(err);
    }
  }

  private async finishCancel(): Promise<void> {
    this.inflight.clear();
    const id = this.session?.id;
    this.deps.store.clear(this.fingerprint);
    if (id) {
      // Best effort with a fresh (non-aborted) signal. If it fails, the server worker + S3 lifecycle clean up.
      await this.deps.api.abort(id).catch(() => undefined);
    }
    this.setState('cancelled', true);
    this.done_.reject(new UploadAbortedError());
  }

  private async execute(): Promise<UploadSessionView> {
    const { api } = this.deps;
    const signal = this.controller.signal;

    this.setState('preparing', true);
    const session = await this.ensureSession(signal);
    this.session = session;
    this.plan = new PartPlan(session.fileSize, session.partSize, session.partCount);

    for (let round = 1; round <= this.maxRounds; round++) {
      // 1) Truth from the server: which parts does S3 actually hold (with the right size)?
      const status = await api.getStatus(session.id, signal);
      if (status.session.status === 'COMPLETED') return status.session;
      if (status.session.status !== 'UPLOADING') {
        throw new UploadError(`Upload is ${status.session.status}`, 'SESSION_NOT_UPLOADABLE', false);
      }
      this.confirmed.clear();
      for (const p of status.uploadedParts) this.confirmed.set(p.partNumber, p.size);

      // 2) Upload ONLY what is missing.
      const missing = this.plan.missing(status.uploadedParts);
      if (missing.length > 0) {
        this.setState('uploading', true);
        const pool = new TaskPool(this.concurrency);
        const { failed } = await pool.run(missing, (n) => this.uploadPart(session.id, n, signal), signal);
        this.retrying = failed.map((f) => f.item).sort((a, b) => a - b);
        this.emit(true);
        if (failed.length > 0) {
          if (round === this.maxRounds) throw failed[0]!.error; // exhausted: surface the real cause
          continue; // next round re-syncs with S3 and retries just these parts
        }
      }

      // 3) Everything present → finalize.
      this.setState('completing', true);
      try {
        return await api.complete(session.id, signal);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'PARTS_MISSING') {
          this.retrying = [
            ...((err.details?.missingParts as number[] | undefined) ?? []),
            ...((err.details?.invalidParts as number[] | undefined) ?? []),
          ];
          continue; // server says exactly which parts → next round re-sends only them
        }
        throw err;
      }
    }
    throw new UploadError('Upload did not converge after several rounds', 'TOO_MANY_ROUNDS', false);
  }

  private async ensureSession(signal: AbortSignal): Promise<UploadSessionView> {
    const { api, store, newId } = this.deps;
    const saved = store.load(this.fingerprint);

    if (saved?.sessionId) {
      try {
        const status = await api.getStatus(saved.sessionId, signal);
        if (status.session.status === 'UPLOADING' && status.session.fileSize === this.file.size) {
          return status.session; // resume: server tells us what is already there
        }
      } catch (err) {
        const gone = err instanceof ApiError && (err.status === 404 || err.status === 410);
        if (!gone) throw err; // transient/auth error: don't throw away a resumable session
      }
      store.clear(this.fingerprint);
    }

    const key = saved?.sessionId ? undefined : saved?.idempotencyKey;
    const idempotencyKey = key ?? (newId ?? (() => crypto.randomUUID()))();
    store.save(this.fingerprint, { idempotencyKey, savedAt: Date.now() }); // BEFORE the call

    const { session } = await api.initiate(
      {
        fileName: this.file.name,
        fileSize: this.file.size,
        contentType: this.file.type || 'application/octet-stream',
      },
      idempotencyKey,
      signal,
    );
    store.save(this.fingerprint, { idempotencyKey, sessionId: session.id, savedAt: Date.now() });
    return session;
  }

  private async uploadPart(sessionId: string, partNumber: number, signal: AbortSignal): Promise<void> {
    const plan = this.plan!;
    const { start, end } = plan.rangeOf(partNumber);
    const blob = this.file.slice(start, end); // lazy slice: no 8 GB read into memory

    await this.deps.partRetry.run(
      async () => {
        // Fresh URL every attempt: costs one tiny API call, removes expiry as a failure mode.
        const [presigned] = await this.deps.api.presign(sessionId, [partNumber], signal);
        if (!presigned) throw new PartUploadError('No URL issued', 'NO_PRESIGNED_URL', true, partNumber);
        this.inflight.set(partNumber, 0);
        try {
          await this.deps.uploader.put(presigned.url, blob, {
            partNumber,
            signal,
            onProgress: (loaded) => {
              this.inflight.set(partNumber, loaded);
              this.emit();
            },
          });
        } finally {
          this.inflight.delete(partNumber); // a retry restarts this part from 0; others are untouched
        }
      },
      {
        signal,
        // 403 usually means a config problem (CORS/IAM/clock), so don't hammer it.
        maxAttemptsFor: (e) => (e instanceof PartUploadError && e.status === 403 ? 2 : undefined),
      },
    );

    this.confirmed.set(partNumber, blob.size);
    this.emit(true);
  }

  private setState(next: TaskState, force = false): void {
    this.state = next;
    this.emit(force);
  }

  private emit(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastEmit < 200) return;
    this.lastEmit = now;

    const snap = this.snapshot();
    const dt = (now - this.lastSample.t) / 1000;
    if (dt >= 0.5) {
      const inst = Math.max(0, (snap.uploadedBytes - this.lastSample.bytes) / dt);
      this.speed = this.speed === 0 ? inst : this.speed * 0.7 + inst * 0.3; // smoothed (EWMA)
      this.lastSample = { t: now, bytes: snap.uploadedBytes };
    }
    const out = this.snapshot();
    for (const l of this.listeners) l(out);
  }
}
