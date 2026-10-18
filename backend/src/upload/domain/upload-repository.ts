import type { UploadSession, UploadStatus } from './upload-session';

export type StaleKind = 'EXPIRED_UPLOADING' | 'STUCK_INITIATING' | 'STUCK_ABORTING' | 'STUCK_COMPLETING';

export interface CreateSessionInput {
  id: string;
  userId: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  partSize: number;
  expectedPartCount: number;
  idempotencyKey: string;
  expiresAt: Date;
  defaultQuotaBytes: number;
  maxActiveUploads: number;
}

/**
 * Port. Every state change is ONE conditional statement (or one transaction) so that
 * multiple API/worker instances can race safely. `null` from a transition = "someone else won".
 */
export interface UploadRepository {
  findById(id: string): Promise<UploadSession | null>;
  findOwned(id: string, userId: string): Promise<UploadSession | null>;
  findByIdempotencyKey(userId: string, key: string): Promise<UploadSession | null>;

  /** Atomically: reserve quota + enforce active-upload cap + insert INITIATING session. */
  createWithReservation(input: CreateSessionInput): Promise<{ session: UploadSession; created: boolean }>;

  /** INITIATING -> UPLOADING with the S3 upload id. */
  attachS3Upload(id: string, s3UploadId: string, expiresAt: Date): Promise<UploadSession | null>;

  /** Plain conditional transition (no quota effect). */
  transition(
    id: string,
    from: readonly UploadStatus[],
    to: UploadStatus,
    failureReason?: string,
  ): Promise<UploadSession | null>;

  /** UPLOADING -> COMPLETING, or re-claim a COMPLETING row whose lease expired. */
  beginCompleting(id: string, leaseSeconds: number): Promise<UploadSession | null>;

  /** COMPLETING -> COMPLETED and move reserved -> used, in one transaction. First caller wins. */
  commit(id: string): Promise<UploadSession | null>;

  /** from -> terminal(FAILED/ABORTED/EXPIRED) and release the reservation, in one transaction. First caller wins. */
  release(
    id: string,
    from: readonly UploadStatus[],
    to: 'FAILED' | 'ABORTED' | 'EXPIRED',
    failureReason?: string,
  ): Promise<UploadSession | null>;

  /** Slide the expiry window forward on activity. */
  touch(id: string, expiresAt: Date): Promise<void>;

  /** Lease-claim stale rows for the maintenance worker (FOR UPDATE SKIP LOCKED). */
  claimStale(kind: StaleKind, limit: number, completingLeaseSeconds: number): Promise<UploadSession[]>;
}
