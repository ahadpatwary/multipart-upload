import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

process.env.DATABASE_URL = 'postgres://unused';
process.env.JWT_SECRET = 'test-secret-test-secret';
process.env.AWS_REGION = 'us-east-1';
process.env.S3_BUCKET = 'test-bucket';
process.env.DEFAULT_QUOTA_BYTES = String(20 * 1024 ** 2); // 20 MiB quota
process.env.MAX_ACTIVE_UPLOADS_PER_USER = '3';

import { AppConfig } from '../src/common/config/app-config';
import { AppLogger } from '../src/common/logger';
import {
  PartsMissingError,
  QuotaExceededError,
  StorageUploadMissingError,
} from '../src/common/errors/app-error';
import { UploadService } from '../src/upload/application/upload-service';
import type { StoragePort, HeadResult } from '../src/upload/domain/storage-port';
import type { StoredPart } from '../src/upload/domain/part-plan';
import type { CreateSessionInput, UploadRepository } from '../src/upload/domain/upload-repository';
import type { UploadSession, UploadStatus } from '../src/upload/domain/upload-session';

const MiB = 1024 ** 2;

// ── in-memory fakes that mirror the real conditional-update semantics ──
class FakeRepo implements UploadRepository {
  sessions = new Map<string, UploadSession>();
  quota = new Map<string, { quota: number; used: number; reserved: number }>();

  async findById(id: string) { return this.sessions.get(id) ?? null; }
  async findOwned(id: string, userId: string) { const s = this.sessions.get(id); return s && s.userId === userId ? s : null; }
  async findByIdempotencyKey(userId: string, key: string) {
    return [...this.sessions.values()].find((s) => s.userId === userId && s.idempotencyKey === key) ?? null;
  }
  async createWithReservation(i: CreateSessionInput) {
    const q = this.quota.get(i.userId) ?? { quota: i.defaultQuotaBytes, used: 0, reserved: 0 };
    this.quota.set(i.userId, q);
    if (q.used + q.reserved + i.fileSize > q.quota) throw new QuotaExceededError();
    q.reserved += i.fileSize;
    const now = new Date();
    const s: UploadSession = {
      id: i.id, userId: i.userId, objectKey: i.objectKey, s3UploadId: null, fileName: i.fileName,
      contentType: i.contentType, fileSize: i.fileSize, partSize: i.partSize, expectedPartCount: i.expectedPartCount,
      status: 'INITIATING', idempotencyKey: i.idempotencyKey, reservedBytes: i.fileSize, expiresAt: i.expiresAt,
      completedAt: null, failureReason: null, createdAt: now, updatedAt: now,
    };
    this.sessions.set(s.id, s);
    return { session: s, created: true };
  }
  async attachS3Upload(id: string, s3: string, exp: Date) {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'INITIATING') return null;
    Object.assign(s, { s3UploadId: s3, status: 'UPLOADING', expiresAt: exp });
    return s;
  }
  async transition(id: string, from: readonly UploadStatus[], to: UploadStatus, reason?: string) {
    const s = this.sessions.get(id);
    if (!s || !from.includes(s.status)) return null;
    s.status = to; if (reason) s.failureReason = reason; s.updatedAt = new Date();
    return s;
  }
  async beginCompleting(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'UPLOADING') return null;
    s.status = 'COMPLETING';
    return s;
  }
  async commit(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.status !== 'COMPLETING') return null;
    s.status = 'COMPLETED'; s.completedAt = new Date();
    const q = this.quota.get(s.userId)!; q.reserved -= s.reservedBytes; q.used += s.fileSize;
    return s;
  }
  async release(id: string, from: readonly UploadStatus[], to: 'FAILED' | 'ABORTED' | 'EXPIRED', reason?: string) {
    const s = this.sessions.get(id);
    if (!s || !from.includes(s.status)) return null;
    s.status = to; if (reason) s.failureReason = reason;
    this.quota.get(s.userId)!.reserved -= s.reservedBytes;
    return s;
  }
  async touch() {}
  async claimStale() { return []; }
}

class FakeStorage implements StoragePort {
  parts = new Map<number, StoredPart>();
  objects = new Map<string, HeadResult>();
  aborted = false;
  completeCalls = 0;
  failCompleteOnce = false;
  private metadata: Record<string, string> = {};
  private keyOf = '';
  private size = 0;

  async createMultipartUpload(i: { key: string; metadata: Record<string, string> }) {
    this.metadata = i.metadata; this.keyOf = i.key; return 'upload-1';
  }
  async presignUploadPart(i: { partNumber: number; contentLength: number }) {
    return `https://s3.example/part/${i.partNumber}?len=${i.contentLength}`;
  }
  async listParts() {
    if (this.aborted) throw new StorageUploadMissingError();
    return [...this.parts.values()];
  }
  async completeMultipartUpload() {
    this.completeCalls++;
    this.size = [...this.parts.values()].reduce((n, p) => n + p.size, 0);
    // Simulates "S3 did the work but the response was lost":
    this.objects.set(this.keyOf, { size: this.size, metadata: this.metadata });
    if (this.failCompleteOnce) { this.failCompleteOnce = false; throw new Error('socket hang up'); }
  }
  async headObject(key: string) { return this.objects.get(key) ?? null; }
  async abortMultipartUpload() { this.aborted = true; }
  async deleteObject(key: string) { this.objects.delete(key); }
  put(partNumber: number, size: number) { this.parts.set(partNumber, { partNumber, size, etag: `"e${partNumber}"` }); }
}

describe('UploadService', () => {
  let repo: FakeRepo;
  let storage: FakeStorage;
  let svc: UploadService;
  const user = 'user-1';
  const fileSize = 12 * MiB + 123; // 5 MiB parts -> 3 parts (5, 5, 2 MiB+123)

  beforeEach(() => {
    repo = new FakeRepo();
    storage = new FakeStorage();
    svc = new UploadService(repo, storage, new AppConfig(), new AppLogger());
  });

  const start = (key = 'idem-key-0001', size = fileSize) =>
    svc.initiate(user, { fileName: 'a.mp4', fileSize: size, contentType: 'video/mp4', partSize: 5 * MiB }, key);

  it('only the MISSING part is reported and re-uploaded; completion then succeeds', async () => {
    const { session } = await start();
    assert.equal(session.partCount, 3);

    storage.put(1, 5 * MiB);
    storage.put(3, fileSize - 10 * MiB); // part 2 never arrived

    const status = await svc.getStatus(user, session.id);
    assert.deepEqual(status.uploadedParts.map((p) => p.partNumber), [1, 3]);

    await assert.rejects(svc.complete(user, session.id), (e: unknown) => {
      assert.ok(e instanceof PartsMissingError);
      assert.deepEqual(e.details, { missingParts: [2], invalidParts: [] });
      return true;
    });
    assert.equal((await repo.findById(session.id))!.status, 'UPLOADING'); // reverted, resumable

    storage.put(2, 5 * MiB); // client retries just part 2
    const done = await svc.complete(user, session.id);
    assert.equal(done.status, 'COMPLETED');
  });

  it('a truncated part is treated as invalid, not as uploaded', async () => {
    const { session } = await start();
    storage.put(1, 5 * MiB); storage.put(2, 1 * MiB); storage.put(3, fileSize - 10 * MiB);
    await assert.rejects(svc.complete(user, session.id), (e: unknown) => {
      assert.ok(e instanceof PartsMissingError);
      assert.deepEqual(e.details, { missingParts: [], invalidParts: [2] });
      return true;
    });
  });

  it('lost CompleteMultipartUpload response: recovered via HeadObject, quota committed exactly once', async () => {
    const { session } = await start();
    storage.put(1, 5 * MiB); storage.put(2, 5 * MiB); storage.put(3, fileSize - 10 * MiB);
    storage.failCompleteOnce = true;

    const done = await svc.complete(user, session.id);
    assert.equal(done.status, 'COMPLETED');
    const again = await svc.complete(user, session.id); // idempotent
    assert.equal(again.status, 'COMPLETED');
    const q = repo.quota.get(user)!;
    assert.equal(q.used, fileSize);
    assert.equal(q.reserved, 0);
  });

  it('same Idempotency-Key replays the same session instead of creating another', async () => {
    const a = await start('idem-key-0002');
    const b = await start('idem-key-0002');
    assert.equal(b.resumed, true);
    assert.equal(a.session.id, b.session.id);
    assert.equal(repo.sessions.size, 1);
  });

  it('quota counts reservations: second upload that would exceed quota is rejected', async () => {
    await start('idem-key-0003', 12 * MiB); // reserves 12 of 20 MiB, nothing completed yet
    await assert.rejects(start('idem-key-0004', 12 * MiB), QuotaExceededError);
  });

  it('abort releases the reservation exactly once and is idempotent', async () => {
    const { session } = await start();
    const first = await svc.abort(user, session.id);
    const second = await svc.abort(user, session.id);
    assert.equal(first.status, 'ABORTED');
    assert.equal(second.status, 'ABORTED');
    assert.equal(repo.quota.get(user)!.reserved, 0);
  });

  it("another user cannot see or control someone else's upload", async () => {
    const { session } = await start();
    await assert.rejects(svc.getStatus('intruder', session.id), { code: 'UPLOAD_NOT_FOUND' });
    await assert.rejects(svc.presignParts('intruder', session.id, [1]), { code: 'UPLOAD_NOT_FOUND' });
  });

  it('presigned URLs are issued only for valid part numbers, sized to the exact part', async () => {
    const { session } = await start();
    const urls = await svc.presignParts(user, session.id, [3]);
    assert.match(urls[0]!.url, /len=2097275$/); // 2 MiB + 123
    await assert.rejects(svc.presignParts(user, session.id, [4]), { code: 'VALIDATION_FAILED' });
  });
});
