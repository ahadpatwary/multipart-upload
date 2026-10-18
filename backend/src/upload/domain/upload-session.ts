export const UPLOAD_STATUSES = [
  'INITIATING',
  'UPLOADING',
  'COMPLETING',
  'COMPLETED',
  'ABORTING',
  'ABORTED',
  'FAILED',
  'EXPIRED',
] as const;

export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const TERMINAL_STATUSES: readonly UploadStatus[] = ['COMPLETED', 'ABORTED', 'FAILED', 'EXPIRED'];

/** Allowed transitions. The repository enforces them with conditional UPDATEs (`WHERE status = ANY(from)`). */
export const ALLOWED_TRANSITIONS: Readonly<Record<UploadStatus, readonly UploadStatus[]>> = {
  INITIATING: ['UPLOADING', 'FAILED'],
  UPLOADING: ['COMPLETING', 'ABORTING'],
  COMPLETING: ['COMPLETED', 'UPLOADING', 'FAILED'],
  ABORTING: ['ABORTED', 'EXPIRED'],
  COMPLETED: [],
  ABORTED: [],
  FAILED: [],
  EXPIRED: [],
};

export interface UploadSession {
  id: string;
  userId: string;
  objectKey: string;
  /** null only while INITIATING (S3 multipart not created yet). */
  s3UploadId: string | null;
  fileName: string;
  contentType: string;
  fileSize: number;
  partSize: number;
  expectedPartCount: number;
  status: UploadStatus;
  idempotencyKey: string;
  reservedBytes: number;
  expiresAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function isTerminal(status: UploadStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
