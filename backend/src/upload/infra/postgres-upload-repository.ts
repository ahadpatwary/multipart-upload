import 'reflect-metadata';
import { inject, singleton } from 'tsyringe';
import type { Pool, PoolClient } from 'pg';
import { TOKENS } from '../../common/tokens';
import { QuotaExceededError, TooManyActiveUploadsError } from '../../common/errors/app-error';
import type { CreateSessionInput, StaleKind, UploadRepository } from '../domain/upload-repository';
import type { UploadSession, UploadStatus } from '../domain/upload-session';

interface SessionRow {
  id: string;
  user_id: string;
  object_key: string;
  s3_upload_id: string | null;
  file_name: string;
  content_type: string;
  file_size: string;
  part_size: string;
  expected_part_count: number;
  status: UploadStatus;
  idempotency_key: string;
  reserved_bytes: string;
  expires_at: Date;
  completed_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, user_id, object_key, s3_upload_id, file_name, content_type, file_size, part_size,
  expected_part_count, status, idempotency_key, reserved_bytes, expires_at, completed_at,
  failure_reason, created_at, updated_at`;

const ACTIVE = `('INITIATING','UPLOADING','COMPLETING','ABORTING')`;

function toSession(r: SessionRow): UploadSession {
  return {
    id: r.id,
    userId: r.user_id,
    objectKey: r.object_key,
    s3UploadId: r.s3_upload_id,
    fileName: r.file_name,
    contentType: r.content_type,
    fileSize: Number(r.file_size),
    partSize: Number(r.part_size),
    expectedPartCount: r.expected_part_count,
    status: r.status,
    idempotencyKey: r.idempotency_key,
    reservedBytes: Number(r.reserved_bytes),
    expiresAt: r.expires_at,
    completedAt: r.completed_at,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === constraint;
}

@singleton()
export class PostgresUploadRepository implements UploadRepository {
  constructor(@inject(TOKENS.PgPool) private readonly pool: Pool) {}

  async findById(id: string): Promise<UploadSession | null> {
    const { rows } = await this.pool.query<SessionRow>(`SELECT ${COLUMNS} FROM upload_sessions WHERE id = $1`, [id]);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async findOwned(id: string, userId: string): Promise<UploadSession | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT ${COLUMNS} FROM upload_sessions WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<UploadSession | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT ${COLUMNS} FROM upload_sessions WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, key],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async createWithReservation(input: CreateSessionInput): Promise<{ session: UploadSession; created: boolean }> {
    try {
      const session = await this.withTx(async (c) => {
        await c.query(
          `INSERT INTO user_storage (user_id, quota_bytes) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
          [input.userId, input.defaultQuotaBytes],
        );

        // One atomic statement = the quota decision. It also row-locks user_storage for this tx,
        // which serialises concurrent initiates of the same user (so the active-cap check below is race-free).
        const reserved = await c.query(
          `UPDATE user_storage
              SET reserved_bytes = reserved_bytes + $2
            WHERE user_id = $1 AND used_bytes + reserved_bytes + $2 <= quota_bytes
        RETURNING quota_bytes, used_bytes, reserved_bytes`,
          [input.userId, input.fileSize],
        );
        if (reserved.rowCount === 0) {
          const snap = await c.query<{ quota_bytes: string; used_bytes: string; reserved_bytes: string }>(
            `SELECT quota_bytes, used_bytes, reserved_bytes FROM user_storage WHERE user_id = $1`,
            [input.userId],
          );
          const s = snap.rows[0];
          throw new QuotaExceededError({
            quotaBytes: s ? Number(s.quota_bytes) : 0,
            usedBytes: s ? Number(s.used_bytes) : 0,
            reservedBytes: s ? Number(s.reserved_bytes) : 0,
            requestedBytes: input.fileSize,
          });
        }

        const active = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM upload_sessions WHERE user_id = $1 AND status IN ${ACTIVE}`,
          [input.userId],
        );
        if (Number(active.rows[0]?.n ?? 0) >= input.maxActiveUploads) {
          throw new TooManyActiveUploadsError(input.maxActiveUploads);
        }

        const inserted = await c.query<SessionRow>(
          `INSERT INTO upload_sessions
             (id, user_id, object_key, file_name, content_type, file_size, part_size, expected_part_count,
              status, idempotency_key, reserved_bytes, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'INITIATING',$9,$6,$10)
           RETURNING ${COLUMNS}`,
          [
            input.id,
            input.userId,
            input.objectKey,
            input.fileName,
            input.contentType,
            input.fileSize,
            input.partSize,
            input.expectedPartCount,
            input.idempotencyKey,
            input.expiresAt,
          ],
        );
        return toSession(inserted.rows[0]!);
      });
      return { session, created: true };
    } catch (err) {
      // Same Idempotency-Key raced in: the tx rolled back (reservation undone); return the winner's row.
      if (isUniqueViolation(err, 'upload_sessions_user_idem_uq')) {
        const existing = await this.findByIdempotencyKey(input.userId, input.idempotencyKey);
        if (existing) return { session: existing, created: false };
      }
      throw err;
    }
  }

  async attachS3Upload(id: string, s3UploadId: string, expiresAt: Date): Promise<UploadSession | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `UPDATE upload_sessions
          SET s3_upload_id = $2, status = 'UPLOADING', expires_at = $3, updated_at = now()
        WHERE id = $1 AND status = 'INITIATING'
    RETURNING ${COLUMNS}`,
      [id, s3UploadId, expiresAt],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async transition(
    id: string,
    from: readonly UploadStatus[],
    to: UploadStatus,
    failureReason?: string,
  ): Promise<UploadSession | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `UPDATE upload_sessions
          SET status = $3, failure_reason = COALESCE($4, failure_reason), updated_at = now()
        WHERE id = $1 AND status = ANY($2::text[])
    RETURNING ${COLUMNS}`,
      [id, from, to, failureReason ?? null],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async beginCompleting(id: string, leaseSeconds: number): Promise<UploadSession | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `UPDATE upload_sessions
          SET status = 'COMPLETING', updated_at = now()
        WHERE id = $1
          AND (status = 'UPLOADING'
               OR (status = 'COMPLETING' AND updated_at < now() - make_interval(secs => $2)))
    RETURNING ${COLUMNS}`,
      [id, leaseSeconds],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  commit(id: string): Promise<UploadSession | null> {
    return this.withTx(async (c) => {
      const { rows } = await c.query<SessionRow>(
        `UPDATE upload_sessions
            SET status = 'COMPLETED', completed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'COMPLETING'
      RETURNING ${COLUMNS}`,
        [id],
      );
      const row = rows[0];
      if (!row) return null; // already committed by someone else: do NOT touch counters twice
      await c.query(
        `UPDATE user_storage
            SET reserved_bytes = reserved_bytes - $2, used_bytes = used_bytes + $3
          WHERE user_id = $1`,
        [row.user_id, row.reserved_bytes, row.file_size],
      );
      return toSession(row);
    });
  }

  release(
    id: string,
    from: readonly UploadStatus[],
    to: 'FAILED' | 'ABORTED' | 'EXPIRED',
    failureReason?: string,
  ): Promise<UploadSession | null> {
    return this.withTx(async (c) => {
      const { rows } = await c.query<SessionRow>(
        `UPDATE upload_sessions
            SET status = $3, failure_reason = COALESCE($4, failure_reason), updated_at = now()
          WHERE id = $1 AND status = ANY($2::text[])
      RETURNING ${COLUMNS}`,
        [id, from, to, failureReason ?? null],
      );
      const row = rows[0];
      if (!row) return null; // already released: reservation must not be released twice
      await c.query(`UPDATE user_storage SET reserved_bytes = reserved_bytes - $2 WHERE user_id = $1`, [
        row.user_id,
        row.reserved_bytes,
      ]);
      return toSession(row);
    });
  }

  async touch(id: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE upload_sessions SET expires_at = GREATEST(expires_at, $2), updated_at = now()
        WHERE id = $1 AND status = 'UPLOADING'`,
      [id, expiresAt],
    );
  }

  async claimStale(kind: StaleKind, limit: number, completingLeaseSeconds: number): Promise<UploadSession[]> {
    const lease = Math.max(1, Math.trunc(completingLeaseSeconds));
    const predicate: Record<StaleKind, string> = {
      EXPIRED_UPLOADING: `status = 'UPLOADING' AND expires_at < now()`,
      STUCK_INITIATING: `status = 'INITIATING' AND updated_at < now() - interval '5 minutes'`,
      STUCK_ABORTING: `status = 'ABORTING' AND updated_at < now() - interval '2 minutes'`,
      STUCK_COMPLETING: `status = 'COMPLETING' AND updated_at < now() - ${lease} * interval '1 second'`,
    };
    const { rows } = await this.pool.query<SessionRow>(
      `UPDATE upload_sessions SET updated_at = now()
        WHERE id IN (
          SELECT id FROM upload_sessions
           WHERE ${predicate[kind]}
           ORDER BY updated_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
    RETURNING ${COLUMNS}`,
      [limit],
    );
    return rows.map(toSession);
  }

  private async withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
