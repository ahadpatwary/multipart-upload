// Mirrors the backend contract. In a monorepo, move this into a shared package.

export type UploadStatus =
  | 'INITIATING'
  | 'UPLOADING'
  | 'COMPLETING'
  | 'COMPLETED'
  | 'ABORTING'
  | 'ABORTED'
  | 'FAILED'
  | 'EXPIRED';

export interface UploadSessionView {
  id: string;
  status: UploadStatus;
  fileName: string;
  fileSize: number;
  contentType: string;
  partSize: number;
  partCount: number;
  expiresAt: string;
  completedAt: string | null;
}

export interface UploadedPart {
  partNumber: number;
  size: number;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
  expiresAt: string;
}

export interface InitiateRequest {
  fileName: string;
  fileSize: number;
  contentType: string;
  partSize?: number;
}

/** Client-side task lifecycle (distinct from the server-side session status). */
export type TaskState =
  | 'idle'
  | 'preparing'
  | 'uploading'
  | 'completing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface UploadProgress {
  state: TaskState;
  totalBytes: number;
  uploadedBytes: number;
  percent: number;
  partsDone: number;
  partCount: number;
  activeParts: number;
  /** Parts that exhausted their retries in the current round and are queued for the next one. */
  retryingParts: number[];
  speedBytesPerSec: number;
  etaSeconds: number | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

export interface UploadOptions {
  /** Parallel part uploads. Default 4. Memory ≈ concurrency × partSize while in flight. */
  concurrency?: number;
  /** Re-sync + retry rounds for parts that failed even after per-part retries. Default 3. */
  maxRounds?: number;
  onProgress?: (p: UploadProgress) => void;
}
