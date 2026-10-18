import type { UploadSession, UploadStatus } from '../domain/upload-session';

export interface InitiateUploadInput {
  fileName: string;
  fileSize: number;
  contentType: string;
  partSize?: number;
}

/** What the client is allowed to know. Never includes s3UploadId, objectKey or bucket details. */
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

export interface UploadedPartView {
  partNumber: number;
  size: number;
}

export interface PresignedPartView {
  partNumber: number;
  url: string;
  expiresAt: string;
}

export function toView(s: UploadSession): UploadSessionView {
  return {
    id: s.id,
    status: s.status,
    fileName: s.fileName,
    fileSize: s.fileSize,
    contentType: s.contentType,
    partSize: s.partSize,
    partCount: s.expectedPartCount,
    expiresAt: s.expiresAt.toISOString(),
    completedAt: s.completedAt ? s.completedAt.toISOString() : null,
  };
}
