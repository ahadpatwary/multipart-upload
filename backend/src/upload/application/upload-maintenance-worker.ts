import 'reflect-metadata';
import { inject, singleton } from 'tsyringe';
import { AppConfig } from '../../common/config/app-config';
import { AppLogger } from '../../common/logger';
import { TOKENS } from '../../common/tokens';
import type { StaleKind, UploadRepository } from '../domain/upload-repository';
import type { UploadSession } from '../domain/upload-session';
import { UploadService } from './upload-service';

/**
 * Reconciler. Rows are claimed with FOR UPDATE SKIP LOCKED, so any number of instances can run it.
 * Every handler is idempotent (state transitions are conditional), so double-processing is harmless.
 * The S3 `AbortIncompleteMultipartUpload` lifecycle rule remains the last-resort backstop.
 */
@singleton()
export class UploadMaintenanceWorker {
  private timer?: NodeJS.Timeout;
  private current: Promise<void> = Promise.resolve();
  private running = false;

  constructor(
    @inject(UploadService) private readonly service: UploadService,
    @inject(TOKENS.UploadRepository) private readonly repo: UploadRepository,
    @inject(AppConfig) private readonly config: AppConfig,
    @inject(AppLogger) private readonly log: AppLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.config.workerIntervalMs);
    this.timer.unref();
    void this.tick();
    this.log.info('Upload maintenance worker started', { intervalMs: this.config.workerIntervalMs });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.current; // let the in-flight sweep finish
  }

  /** Exposed for tests / manual triggering. */
  tick(): Promise<void> {
    if (this.running) return this.current;
    this.running = true;
    this.current = this.sweepAll().finally(() => {
      this.running = false;
    });
    return this.current;
  }

  private async sweepAll(): Promise<void> {
    await this.sweep('EXPIRED_UPLOADING', (s) => this.service.expire(s));
    await this.sweep('STUCK_ABORTING', (s) => this.service.resumeAbort(s));
    await this.sweep('STUCK_COMPLETING', (s) => this.service.recoverCompleting(s));
    await this.sweep('STUCK_INITIATING', (s) => this.service.recoverInitiating(s));
  }

  private async sweep(kind: StaleKind, handler: (s: UploadSession) => Promise<void>): Promise<void> {
    let batch: UploadSession[];
    try {
      batch = await this.repo.claimStale(kind, this.config.workerBatchSize, this.config.completingLeaseSeconds);
    } catch (err) {
      this.log.error(`claimStale(${kind}) failed`, err);
      return;
    }
    for (const session of batch) {
      try {
        await handler(session);
        this.log.info('Recovered upload session', { kind, sessionId: session.id });
      } catch (err) {
        // Leave the row as-is: its lease expires and the next sweep retries it.
        this.log.error(`Recovery failed (${kind})`, err, { sessionId: session.id });
      }
    }
  }
}
