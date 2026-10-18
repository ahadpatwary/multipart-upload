import type { StoredPart } from './part-plan';

export interface HeadResult {
  size: number;
  metadata: Record<string, string>;
}

/** Port: the application layer only knows this interface, never the AWS SDK. */
export interface StoragePort {
  createMultipartUpload(input: { key: string; contentType: string; metadata: Record<string, string> }): Promise<string>;

  presignUploadPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string>;

  /** All parts S3 currently holds (handles pagination). Throws StorageUploadMissingError if upload is gone. */
  listParts(key: string, uploadId: string): Promise<StoredPart[]>;

  completeMultipartUpload(key: string, uploadId: string, parts: ReadonlyArray<Pick<StoredPart, 'partNumber' | 'etag'>>): Promise<void>;

  /** null when the object does not exist. */
  headObject(key: string): Promise<HeadResult | null>;

  /** Idempotent: aborting an already-gone upload is not an error. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  deleteObject(key: string): Promise<void>;
}
