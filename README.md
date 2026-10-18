# Resumable large-file upload — Next.js + NestJS + S3 multipart (tsyringe, class-based)

Browser → **S3 directly** (data plane). NestJS only does auth, quota, state and presigned URLs (control plane).
Files of 7–20 GB work; a failed chunk is retried **alone**.

```
upload-system/
├─ backend/    NestJS 11 · tsyringe DI · Postgres (pg) · AWS SDK v3 · zod
│  ├─ migrations/001_init.sql
│  ├─ src/
│  │  ├─ container.ts                 composition root (tsyringe) + Nest bridge
│  │  ├─ common/                      config, errors, logger, exception filter
│  │  └─ upload/
│  │     ├─ domain/                   state machine, PartPlan, ports (StoragePort, UploadRepository)
│  │     ├─ application/              UploadService, UploadMaintenanceWorker
│  │     ├─ infra/                    S3MultipartStorage, PostgresUploadRepository
│  │     └─ http/                     controller, guard, zod schemas
│  └─ test/upload-service.test.ts
└─ frontend/   Next.js 15 · tsyringe DI
   └─ src/lib/upload/
      ├─ upload-task.ts               orchestrator (rounds, pause/resume/cancel)
      ├─ retry-policy.ts              exponential backoff + full jitter
      ├─ task-pool.ts                 bounded concurrency, failures isolated per part
      ├─ part-uploader.ts             XHR PUT to S3 (progress, stall timeout, error classification)
      ├─ upload-api.ts / http-client.ts   control-plane client
      ├─ resume-store.ts              idempotency key + session id per file
      └─ container.ts                 tsyringe wiring
```

## How a chunk-level retry actually works

1. Server decides `partSize` (default 128 MiB) and `partCount`. Client derives each byte range from them.
2. Each part: **fresh presigned URL** (signed with exact `Content-Length`) → XHR `PUT`.
   Failure (network, 5xx, 429, stall, expired URL) → retry **that part only**, backoff + jitter, max 5 attempts.
   Other parts keep going (`TaskPool` never cancels siblings on a retryable failure).
3. A part that exhausts its attempts is parked; next **round** starts with `GET /uploads/:id`, which asks
   **S3 `ListParts`** (not the client) what exists. Only parts that are missing or have the wrong size are sent.
4. `POST /complete` re-verifies against `ListParts`. If anything is missing it answers `409 PARTS_MISSING`
   with `{missingParts, invalidParts}`; the client re-sends exactly those, then completes.
5. The server completes using **S3's own ETag list**, so the client can't submit a forged/partial part list.
   (This also means the browser doesn't need to read the `ETag` header.)

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/uploads` (header `Idempotency-Key`) | reserve quota, create multipart, return `{session, resumed}` |
| GET | `/uploads/:id` | status + `uploadedParts` from S3 (resume source of truth) |
| POST | `/uploads/:id/parts/presign` `{partNumbers}` | presigned `UploadPart` URLs |
| POST | `/uploads/:id/complete` | verify + `CompleteMultipartUpload` (idempotent) |
| POST | `/uploads/:id/abort` | cancel + free quota (idempotent) |

Errors: `{ "error": { code, message, retryable, details?, requestId } }`.
Codes: `VALIDATION_FAILED, UNAUTHORIZED, UPLOAD_NOT_FOUND, UPLOAD_EXPIRED, QUOTA_EXCEEDED, TOO_MANY_ACTIVE_UPLOADS,
INVALID_STATE, IDEMPOTENCY_CONFLICT, OPERATION_IN_PROGRESS, PARTS_MISSING, INTEGRITY_CHECK_FAILED, STORAGE_ERROR, INTERNAL_ERROR`.

## Design decisions worth knowing

- **tsyringe + Nest.** Business classes (`UploadService`, repo, S3 adapter, worker) are `@singleton()`/`@injectable()` with
  explicit `@inject(...)`. Nest controllers/guards get them through `fromContainer(Class)` providers in `app.module.ts`.
  Interfaces (`StoragePort`, `UploadRepository`) are bound by Symbol in `container.ts` only.
- **State machine, atomic in the DB.** Every transition is one conditional `UPDATE … WHERE status = ANY(from)`;
  `commit` / `release` change the session **and** quota counters in one transaction, and only the first caller wins, so
  quota is never double-committed or double-released. Safe across many API/worker instances (no in-memory locks).
- **Quota = `quota − used − reserved`**, reserved with a single atomic `UPDATE … WHERE used+reserved+$n <= quota`.
  The same transaction enforces the max-active-uploads cap (the row lock serialises concurrent initiates).
- **DB ≠ S3 transaction.** Initiate compensates explicitly (release on S3 failure, abort S3 on DB failure).
  Leftovers are handled by the worker + the S3 lifecycle rule.
- **Lost `CompleteMultipartUpload` response.** Session stays `COMPLETING` (with a lease); recovery uses `HeadObject`
  and the `upload-session-id` object metadata to prove the object is ours before committing.
- **Maintenance worker** (`FOR UPDATE SKIP LOCKED`): expires abandoned uploads, resumes stuck aborts,
  re-drives stuck completions, releases stuck initiations. Run embedded (`ENABLE_EMBEDDED_WORKER=true`) or as
  `npm run start:worker`.
- Object keys are server-generated (`prefix/userId/uuid`); the user's filename is display-only.

## Run it

```bash
# backend
cd backend && cp .env.example .env     # fill DATABASE_URL, JWT_SECRET, AWS_*, S3_BUCKET
npm i && npm run migrate && npm run dev

# frontend
cd frontend && cp .env.local.example .env.local
npm i && npm run dev
```
Frontend auth: implement `AuthTokenProvider` (`src/lib/upload/container.ts`; demo reads `localStorage.access_token`).
Backend auth: `JwtAuthGuard` is a minimal HS256 guard; swap in your real one as long as it sets `request.user.id`.
AWS credentials come from the standard provider chain (use an IAM role in production).

## S3 bucket setup (required)

**CORS** (browser PUTs directly to S3):
```json
[{
  "AllowedOrigins": ["https://app.example.com"],
  "AllowedMethods": ["PUT"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000
}]
```

**Lifecycle** (last-resort cleanup of orphaned parts; they are billed until aborted):
```json
{ "Rules": [{
  "ID": "abort-incomplete-multipart",
  "Status": "Enabled",
  "Filter": { "Prefix": "" },
  "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 3 }
}]}
```

**IAM for the API role** (scope to your prefix):
```json
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::YOUR_BUCKET/private-uploads/*"
}]}
```
(`GetObject` is needed for `HeadObject`.) Keep the bucket private and block public access.

## What was verified, and what was not

Verified here: both projects type-check under `strict`; the Next.js production build succeeds; **16 automated tests pass**
(backend 8: missing/truncated part → `PARTS_MISSING`, lost-complete recovery, idempotent initiate, quota
reservation, idempotent abort, ownership isolation, presign bounds; frontend 8: per-chunk retry isolation, round
re-sync, targeted re-send after `PARTS_MISSING`, fatal errors, resume-after-failure, backoff, pool concurrency).

**Not** verified: a run against real S3 and real Postgres (the tests use in-memory fakes of the two ports), and a
real-browser upload of a multi-GB file. Do that before shipping: run against a real bucket (or MinIO via `S3_ENDPOINT`),
upload a file of several GiB, then kill the network mid-way, close/reopen the tab, and cancel during upload.
Also check the Postgres SQL under concurrent initiates (two tabs, same user, quota boundary).

## Before production

- Rate-limit `/uploads*` (e.g. `@nestjs/throttler`); presign is cheap but not free.
- Post-upload validation (magic-byte/ffprobe check, malware scan) before the file is usable. Don't trust `Content-Type`.
- Optional end-to-end integrity: send a SHA-256 per part and use S3 additional checksums. Multipart ETag is **not** an MD5 of the file.
- Metrics: upload duration, retries/retried bytes, age of incomplete sessions, reserved vs actual storage drift.
- Tune `partSize` (64–256 MiB) and `concurrency` (3–5) by benchmark; memory in flight ≈ `concurrency × partSize`.
- Refresh-token handling: `AuthTokenProvider.getToken()` is called per request, so refresh there; an expired token mid-upload surfaces as `UNAUTHORIZED` (non-retryable) and `resume()` continues after re-login.
