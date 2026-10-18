import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError, NetworkError, PartUploadError } from '../src/lib/upload/errors';
import { PartPlan } from '../src/lib/upload/part-plan';
import { ResumeStore } from '../src/lib/upload/resume-store';
import { RetryPolicy } from '../src/lib/upload/retry-policy';
import { TaskPool } from '../src/lib/upload/task-pool';
import { UploadTask } from '../src/lib/upload/upload-task';
import type { PartUploader } from '../src/lib/upload/part-uploader';
import type { UploadApi } from '../src/lib/upload/upload-api';
import type { UploadedPart, UploadSessionView } from '../src/lib/upload/types';

const MiB = 1024 * 1024;
const FILE_SIZE = 12 * MiB + 123; // parts: 5MiB, 5MiB, 2MiB+123
const noSleepRetry = (maxAttempts: number) => new RetryPolicy({ maxAttempts, baseDelayMs: 1, maxDelayMs: 1 }, () => 0, async () => {});

function makeSession(status: UploadSessionView['status'] = 'UPLOADING'): UploadSessionView {
  return {
    id: 'sess-1', status, fileName: 'v.mp4', fileSize: FILE_SIZE, contentType: 'video/mp4',
    partSize: 5 * MiB, partCount: 3, expiresAt: new Date().toISOString(), completedAt: null,
  };
}

/** A fake server+S3 pair with the same contract as the real backend. */
function makeWorld(opts: { failPart?: number; failTimes?: number } = {}) {
  const stored = new Map<number, number>(); // partNumber -> size in "S3"
  const attempts = new Map<number, number>(); // partNumber -> PUT attempts
  let completeCalls = 0;
  let failuresLeft = opts.failTimes ?? 0;
  const plan = new PartPlan(FILE_SIZE, 5 * MiB, 3);

  const api = {
    initiate: async () => ({ session: makeSession(), resumed: false }),
    getStatus: async () => ({
      session: makeSession(),
      uploadedParts: [...stored].map(([partNumber, size]): UploadedPart => ({ partNumber, size })),
    }),
    presign: async (_id: string, nums: number[]) => nums.map((n) => ({ partNumber: n, url: `https://s3/${n}`, expiresAt: '' })),
    complete: async () => {
      completeCalls++;
      const { missing } = { missing: plan.missing([...stored].map(([partNumber, size]) => ({ partNumber, size }))) };
      if (missing.length) throw new ApiError('missing', 'PARTS_MISSING', true, 409, undefined, { missingParts: missing, invalidParts: [] });
      return makeSession('COMPLETED');
    },
    abort: async () => {},
  } as unknown as UploadApi;

  const uploader = {
    put: async (url: string, blob: Blob, o: { partNumber: number }) => {
      const n = o.partNumber;
      attempts.set(n, (attempts.get(n) ?? 0) + 1);
      if (n === opts.failPart && failuresLeft > 0) {
        failuresLeft--;
        throw new NetworkError('boom');
      }
      stored.set(n, blob.size);
    },
  } as unknown as PartUploader;

  return { api, uploader, stored, attempts, completeCalls: () => completeCalls };
}

const makeFile = () => new File([new Uint8Array(FILE_SIZE)], 'v.mp4', { type: 'video/mp4' });

function makeTask(world: ReturnType<typeof makeWorld>, partAttempts = 3, maxRounds = 3) {
  const file = makeFile();
  return new UploadTask(
    file,
    { api: world.api, uploader: world.uploader, store: new ResumeStore(), partRetry: noSleepRetry(partAttempts) },
    { concurrency: 2, maxRounds },
    ResumeStore.fingerprint(file) + Math.random(),
  );
}

describe('UploadTask: per-chunk retry', () => {
  it('a flaky chunk is retried alone; other chunks are uploaded exactly once', async () => {
    const world = makeWorld({ failPart: 2, failTimes: 2 });
    const done = await makeTask(world, 5).start();
    assert.equal(done.status, 'COMPLETED');
    assert.equal(world.attempts.get(1), 1);
    assert.equal(world.attempts.get(3), 1);
    assert.equal(world.attempts.get(2), 3); // 2 failures + 1 success
  });

  it('a chunk that exhausts its retries is re-queued next round and ONLY it is re-sent', async () => {
    // 2 attempts/round, part 2 fails 3 times: round 1 gives up on it, round 2 succeeds on its 2nd attempt.
    const world = makeWorld({ failPart: 2, failTimes: 3 });
    const done = await makeTask(world, 2).start();
    assert.equal(done.status, 'COMPLETED');
    assert.equal(world.attempts.get(1), 1);
    assert.equal(world.attempts.get(3), 1);
    assert.equal(world.attempts.get(2), 4);
  });

  it('server-side PARTS_MISSING after upload triggers a targeted re-send of just that part', async () => {
    const world = makeWorld();
    const task = makeTask(world);
    // Sabotage: S3 "loses" part 3 after the client saw success, before the first complete().
    const originalPut = (world.uploader as unknown as { put: (...a: never[]) => Promise<void> }).put;
    let sabotaged = false;
    (world.uploader as unknown as { put: unknown }).put = async (...args: never[]) => {
      await originalPut(...args);
      const n = (args[2] as { partNumber: number }).partNumber;
      if (n === 3 && !sabotaged) { sabotaged = true; world.stored.delete(3); }
    };
    const done = await task.start();
    assert.equal(done.status, 'COMPLETED');
    assert.equal(world.attempts.get(3), 2);
    assert.equal(world.attempts.get(1), 1);
    assert.equal(world.attempts.get(2), 1);
    assert.equal(world.completeCalls(), 2);
  });

  it('a non-retryable error stops the upload instead of looping', async () => {
    const world = makeWorld();
    (world.uploader as unknown as { put: unknown }).put = async (_u: string, _b: Blob, o: { partNumber: number }) => {
      throw new PartUploadError('gone', 'PART_UPLOAD_GONE', false, o.partNumber, 404);
    };
    await assert.rejects(makeTask(world).start(), { code: 'PART_UPLOAD_GONE' });
  });

  it('after failure, resume() skips parts that already landed', async () => {
    const world = makeWorld({ failPart: 2, failTimes: 100 });
    const task = makeTask(world, 1, 1);
    await assert.rejects(task.start());
    assert.equal(task.snapshot().state, 'failed');
    // network heals
    (world.uploader as unknown as { put: unknown }).put = async (_u: string, b: Blob, o: { partNumber: number }) => {
      world.attempts.set(o.partNumber, (world.attempts.get(o.partNumber) ?? 0) + 1);
      world.stored.set(o.partNumber, b.size);
    };
    const before1 = world.attempts.get(1);
    const done = await task.resume();
    assert.equal(done.status, 'COMPLETED');
    assert.equal(world.attempts.get(1), before1); // part 1 NOT re-uploaded
  });
});

describe('building blocks', () => {
  it('RetryPolicy: full-jitter backoff is bounded and honours non-retryable errors', async () => {
    const p = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 }, () => 0.999);
    assert.ok(p.delayFor(1) <= 100);
    assert.ok(p.delayFor(4) <= 800);
    assert.ok(p.delayFor(10) <= 1000);

    let calls = 0;
    await assert.rejects(
      noSleepRetry(5).run(async () => { calls++; throw new PartUploadError('x', 'X', false, 1, 400); }),
    );
    assert.equal(calls, 1);
  });

  it('TaskPool: respects concurrency and keeps going when one item fails retryably', async () => {
    let active = 0; let peak = 0;
    const pool = new TaskPool(3);
    const { failed } = await pool.run([1, 2, 3, 4, 5, 6, 7], async (n) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (n === 4) throw new NetworkError();
    });
    assert.equal(peak, 3);
    assert.deepEqual(failed.map((f) => f.item), [4]);
  });

  it('PartPlan: missing() treats wrong-size parts as missing', () => {
    const plan = new PartPlan(FILE_SIZE, 5 * MiB, 3);
    assert.deepEqual(plan.missing([{ partNumber: 1, size: 5 * MiB }, { partNumber: 2, size: 1 }]), [2, 3]);
  });
});
