import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { inject, singleton } from 'tsyringe';
import { AppConfig } from '../../common/config/app-config';
import { AppLogger } from '../../common/logger';
import { TOKENS } from '../../common/tokens';
import {
  IdempotencyConflictError,
  IntegrityError,
  InvalidStateError,
  OperationInProgressError,
  PartsMissingError,
  SessionExpiredError,
  SessionNotFoundError,
  StorageUploadMissingError,
  ValidationFailedError,
} from '../../common/errors/app-error';
import type { StoragePort } from '../domain/storage-port';
import type { UploadRepository } from '../domain/upload-repository';
import { PartPlan, type StoredPart } from '../domain/part-plan';
import { isTerminal, type UploadSession } from '../domain/upload-session';
import {
  toView,
  type InitiateUploadInput,
  type PresignedPartView,
  type UploadedPartView,
  type UploadSessionView,
} from './dto';

const SESSION_META_KEY = 'upload-session-id';

@singleton()
export class UploadService {
  constructor(
    @inject(TOKENS.UploadRepository) private readonly repo: UploadRepository,
    @inject(TOKENS.StoragePort) private readonly storage: StoragePort,
    @inject(AppConfig) private readonly config: AppConfig,
    @inject(AppLogger) private readonly log: AppLogger,
  ) {}

  // ───────────────────────────── Phase A: initiate ─────────────────────────────

  async initiate(
    userId: string,
    input: InitiateUploadInput,
    idempotencyKey: string,
  ): Promise<{ session: UploadSessionView; resumed: boolean }> {
    const existing = await this.repo.findByIdempotencyKey(userId, idempotencyKey);
    if (existing) return this.replayInitiate(existing, input);

    this.validateInput(input);
    const plan = PartPlan.create(input.fileSize, input.partSize ?? this.config.defaultPartSizeBytes);

    // Server-generated key. The user's filename is display-only and never part of the S3 path.
    const objectKey = `${this.config.s3KeyPrefix}/${userId}/${randomUUID()}`;
    const id = randomUUID();

    // 1) DB: quota reservation + session row (one transaction).
    const { session, created } = await this.repo.createWithReservation({
      id,
      userId,
      objectKey,
      fileName: this.sanitizeFileName(input.fileName),
      contentType: input.contentType,
      fileSize: input.fileSize,
      partSize: plan.partSize,
      expectedPartCount: plan.partCount,
      idempotencyKey,
      expiresAt: this.newExpiry(),
      defaultQuotaBytes: this.config.defaultQuotaBytes,
      maxActiveUploads: this.config.maxActiveUploadsPerUser,
    });
    if (!created) return this.replayInitiate(session, input);

    // 2) S3: create multipart. DB and S3 are not one transaction, so failures compensate explicitly.
    let uploadId: string;
    try {
      uploadId = await this.storage.createMultipartUpload({
        key: session.objectKey,
        contentType: session.contentType,
        metadata: { [SESSION_META_KEY]: session.id },
      });
    } catch (err) {
      await this.repo
        .release(session.id, ['INITIATING'], 'FAILED', 'S3_INITIATE_FAILED')
        .catch((e) => this.log.error('release after failed S3 initiate failed', e, { sessionId: session.id }));
      throw err;
    }

    // 3) DB: attach S3 id and open for uploading.
    let attached: UploadSession | null = null;
    try {
      attached = await this.repo.attachS3Upload(session.id, uploadId, this.newExpiry());
    } catch (err) {
      this.log.error('attachS3Upload failed', err, { sessionId: session.id });
    }
    if (!attached) {
      // Best effort cleanup. If this also fails, the S3 lifecycle rule is the final safety net
      // and the worker releases the (still INITIATING) reservation.
      await this.storage
        .abortMultipartUpload(session.objectKey, uploadId)
        .catch((e) => this.log.error('orphan multipart abort failed', e, { sessionId: session.id }));
      await this.repo.release(session.id, ['INITIATING'], 'FAILED', 'ATTACH_FAILED').catch(() => undefined);
      throw new InvalidStateError('Could not open the upload session; please retry');
    }

    return { session: toView(attached), resumed: false };
  }

  private replayInitiate(existing: UploadSession, input: InitiateUploadInput): { session: UploadSessionView; resumed: boolean } {
    if (existing.fileSize !== input.fileSize || existing.contentType !== input.contentType) {
      throw new IdempotencyConflictError();
    }
    if (existing.status === 'INITIATING') {
      throw new OperationInProgressError('The original initiate request is still being processed');
    }
    if (existing.status !== 'UPLOADING') {
      throw new InvalidStateError('This Idempotency-Key belongs to a finished upload; use a new key', {
        status: existing.status,
      });
    }
    return { session: toView(existing), resumed: true };
  }

  // ───────────────────────────── status / resume ─────────────────────────────

  /** Resume metadata. `uploadedParts` is read from S3 (the truth), never from client-reported progress. */
  async getStatus(
    userId: string,
    id: string,
  ): Promise<{ session: UploadSessionView; uploadedParts: UploadedPartView[] }> {
    const s = await this.mustOwn(userId, id);
    if (s.status !== 'UPLOADING' || !s.s3UploadId) return { session: toView(s), uploadedParts: [] };

    const stored = await this.listPartsOrExpire(s);
    const plan = PartPlan.fromSession(s);
    const { missing, invalid } = plan.verify(stored);
    const bad = new Set([...missing, ...invalid]);
    const uploadedParts = stored
      .filter((p) => plan.isValidPartNumber(p.partNumber) && !bad.has(p.partNumber))
      .map((p) => ({ partNumber: p.partNumber, size: p.size }))
      .sort((a, b) => a.partNumber - b.partNumber);
    return { session: toView(s), uploadedParts };
  }

  // ───────────────────────────── Phase B: presign ─────────────────────────────

  async presignParts(userId: string, id: string, partNumbers: number[]): Promise<PresignedPartView[]> {
    const s = await this.mustOwn(userId, id);
    this.assertUploadable(s);
    const plan = PartPlan.fromSession(s);

    const unique = [...new Set(partNumbers)];
    if (unique.length === 0 || unique.length > this.config.maxPresignBatch) {
      throw new ValidationFailedError(`partNumbers must contain 1..${this.config.maxPresignBatch} items`);
    }
    for (const n of unique) {
      if (!plan.isValidPartNumber(n)) {
        throw new ValidationFailedError(`Invalid part number ${n}`, { partCount: plan.partCount });
      }
    }

    const ttl = this.config.presignTtlSeconds;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const urls = await Promise.all(
      unique.map(async (partNumber) => ({
        partNumber,
        expiresAt,
        url: await this.storage.presignUploadPart({
          key: s.objectKey,
          uploadId: s.s3UploadId!,
          partNumber,
          contentLength: plan.lengthOf(partNumber),
          expiresInSeconds: ttl,
        }),
      })),
    );

    await this.repo.touch(s.id, this.newExpiry()); // active uploads don't expire mid-flight
    return urls;
  }

  // ───────────────────────────── Phase D: complete ─────────────────────────────

  async complete(userId: string, id: string): Promise<UploadSessionView> {
    const s = await this.mustOwn(userId, id);
    if (s.status === 'COMPLETED') return toView(s); // idempotent
    if (s.status !== 'UPLOADING' && s.status !== 'COMPLETING') {
      throw new InvalidStateError(`Cannot complete an upload in state ${s.status}`, { status: s.status });
    }

    // Atomic claim; also steals a COMPLETING row whose lease expired (crashed instance).
    const claimed = await this.repo.beginCompleting(s.id, this.config.completingLeaseSeconds);
    if (!claimed) throw new OperationInProgressError('Completion is already in progress');

    return toView(await this.driveCompletion(claimed));
  }

  /**
   * Runs with the COMPLETING claim. Safe to call again after a crash at any point:
   *  - object already assembled?  -> just finalize
   *  - parts incomplete?          -> revert to UPLOADING and tell the client exactly which parts to resend
   *  - S3 call outcome unknown?   -> stay COMPLETING; lease expiry lets the client/worker re-drive
   */
  private async driveCompletion(s: UploadSession): Promise<UploadSession> {
    if (!s.s3UploadId) throw new InvalidStateError('Upload has no storage session');

    // Lost-response recovery: a previous attempt may already have created the object.
    const already = await this.storage.headObject(s.objectKey);
    if (already && already.metadata[SESSION_META_KEY] === s.id) return this.finalizeObject(s, already.size);

    let stored: StoredPart[];
    try {
      stored = await this.storage.listParts(s.objectKey, s.s3UploadId);
    } catch (err) {
      if (err instanceof StorageUploadMissingError) return this.failMissingUpload(s);
      throw err;
    }

    // Source of truth = S3's own part list, NOT the client's. A tampered client cannot complete a bad object.
    const { missing, invalid } = PartPlan.fromSession(s).verify(stored);
    if (missing.length > 0 || invalid.length > 0) {
      await this.repo.transition(s.id, ['COMPLETING'], 'UPLOADING');
      throw new PartsMissingError(missing, invalid);
    }

    try {
      await this.storage.completeMultipartUpload(
        s.objectKey,
        s.s3UploadId,
        stored.filter((p) => p.partNumber <= s.expectedPartCount),
      );
    } catch (err) {
      // Outcome unknown (timeout / lost response)? Ask S3 before deciding anything.
      const obj = await this.storage.headObject(s.objectKey).catch(() => null);
      if (obj && obj.metadata[SESSION_META_KEY] === s.id) return this.finalizeObject(s, obj.size);
      if (err instanceof StorageUploadMissingError) return this.failMissingUpload(s);
      throw err; // stays COMPLETING; retried by client or by the worker after the lease
    }

    const obj = await this.storage.headObject(s.objectKey);
    if (!obj) throw new IntegrityError('Object not found after completion');
    return this.finalizeObject(s, obj.size);
  }

  private async finalizeObject(s: UploadSession, actualSize: number): Promise<UploadSession> {
    if (actualSize !== s.fileSize) {
      await this.storage.deleteObject(s.objectKey).catch((e) => this.log.error('delete bad object failed', e));
      await this.repo.release(s.id, ['COMPLETING'], 'FAILED', 'SIZE_MISMATCH');
      throw new IntegrityError('Assembled object size does not match the declared file size', {
        expected: s.fileSize,
        actual: actualSize,
      });
    }
    const done = await this.repo.commit(s.id);
    if (done) return done;
    return (await this.repo.findById(s.id)) ?? s; // someone else already committed
  }

  private async failMissingUpload(s: UploadSession): Promise<never> {
    // Storage session vanished and the object doesn't exist: terminal. Release the quota.
    await this.repo.release(s.id, ['COMPLETING', 'UPLOADING'], 'FAILED', 'STORAGE_UPLOAD_MISSING');
    throw new SessionExpiredError();
  }

  // ───────────────────────────── cancel / expire ─────────────────────────────

  async abort(userId: string, id: string): Promise<UploadSessionView> {
    const s = await this.mustOwn(userId, id);
    if (isTerminal(s.status)) return toView(s); // idempotent
    if (s.status === 'COMPLETING') {
      throw new InvalidStateError('Upload is being finalized and can no longer be cancelled');
    }
    const aborting = await this.repo.transition(s.id, ['INITIATING', 'UPLOADING', 'ABORTING'], 'ABORTING');
    if (!aborting) throw new OperationInProgressError();
    return toView(await this.driveAbort(aborting, 'ABORTED'));
  }

  /**
   * Stop new presigns (state = ABORTING), tell S3 to abort, then double-check that no straggling
   * in-flight part resurrected data (S3 docs: parts in flight during abort may still land).
   */
  private async driveAbort(s: UploadSession, finalStatus: 'ABORTED' | 'EXPIRED'): Promise<UploadSession> {
    if (s.s3UploadId) {
      await this.storage.abortMultipartUpload(s.objectKey, s.s3UploadId);
      let leftovers: StoredPart[] = [];
      try {
        leftovers = await this.storage.listParts(s.objectKey, s.s3UploadId);
      } catch (err) {
        if (!(err instanceof StorageUploadMissingError)) throw err; // upload gone = clean
      }
      if (leftovers.length > 0) {
        await this.storage.abortMultipartUpload(s.objectKey, s.s3UploadId); // second pass
      }
    }
    const done = await this.repo.release(s.id, ['ABORTING'], finalStatus, finalStatus === 'EXPIRED' ? 'EXPIRED' : undefined);
    return done ?? (await this.repo.findById(s.id)) ?? s;
  }

  // ───────────────────────────── worker entry points ─────────────────────────────

  async expire(s: UploadSession): Promise<void> {
    const aborting = await this.repo.transition(s.id, ['UPLOADING'], 'ABORTING', 'EXPIRED');
    if (aborting) await this.driveAbort(aborting, 'EXPIRED');
  }

  async resumeAbort(s: UploadSession): Promise<void> {
    await this.driveAbort(s, s.failureReason === 'EXPIRED' ? 'EXPIRED' : 'ABORTED');
  }

  async recoverInitiating(s: UploadSession): Promise<void> {
    // The S3 id was never attached. If an orphan S3 upload exists, the bucket lifecycle rule removes it.
    await this.repo.release(s.id, ['INITIATING'], 'FAILED', 'INITIATION_INTERRUPTED');
  }

  async recoverCompleting(s: UploadSession): Promise<void> {
    try {
      await this.driveCompletion(s);
    } catch (err) {
      if (err instanceof PartsMissingError) return; // reverted to UPLOADING; expires naturally if abandoned
      throw err;
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async mustOwn(userId: string, id: string): Promise<UploadSession> {
    const s = await this.repo.findOwned(id, userId);
    if (!s) throw new SessionNotFoundError(); // same answer for "missing" and "someone else's"
    return s;
  }

  private assertUploadable(s: UploadSession): void {
    if (s.status !== 'UPLOADING' || !s.s3UploadId) {
      if (s.status === 'ABORTED' || s.status === 'EXPIRED' || s.status === 'FAILED') throw new SessionExpiredError();
      throw new InvalidStateError(`Upload is not accepting parts in state ${s.status}`, { status: s.status });
    }
    if (s.expiresAt.getTime() < Date.now()) throw new SessionExpiredError();
  }

  private async listPartsOrExpire(s: UploadSession): Promise<StoredPart[]> {
    try {
      return await this.storage.listParts(s.objectKey, s.s3UploadId!);
    } catch (err) {
      if (err instanceof StorageUploadMissingError) {
        // Lifecycle rule (or someone) removed the multipart upload: stale session, free the quota.
        await this.repo.release(s.id, ['UPLOADING'], 'EXPIRED', 'STORAGE_UPLOAD_MISSING');
        throw new SessionExpiredError();
      }
      throw err;
    }
  }

  private validateInput(input: InitiateUploadInput): void {
    if (input.fileSize > this.config.maxFileSizeBytes) {
      throw new ValidationFailedError('File exceeds the maximum allowed size', {
        maxFileSizeBytes: this.config.maxFileSizeBytes,
      });
    }
    const type = input.contentType.toLowerCase();
    if (!this.config.allowedContentTypePrefixes.some((p) => type.startsWith(p.toLowerCase()))) {
      throw new ValidationFailedError('File type is not allowed', {
        allowed: this.config.allowedContentTypePrefixes,
      });
    }
  }

  private sanitizeFileName(name: string): string {
    // Display-only. Strip path separators and control chars; cap length.
    // eslint-disable-next-line no-control-regex
    const cleaned = name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 255);
    return cleaned.length > 0 ? cleaned : 'upload';
  }

  private newExpiry(): Date {
    return new Date(Date.now() + this.config.sessionTtlSeconds * 1000);
  }
}
