import 'reflect-metadata';
import { inject, singleton } from 'tsyringe';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppConfig } from '../../common/config/app-config';
import { TOKENS } from '../../common/tokens';
import { StorageError, StorageUploadMissingError } from '../../common/errors/app-error';
import type { StoragePort, HeadResult } from '../domain/storage-port';
import type { StoredPart } from '../domain/part-plan';

const RETRYABLE_NAMES = new Set([
  'SlowDown',
  'ThrottlingException',
  'RequestTimeout',
  'RequestTimeoutException',
  'InternalError',
  'ServiceUnavailable',
  'TimeoutError',
]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND']);

interface AwsLikeError {
  name?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number };
}

/** AWS SDK adapter. All SDK-specific error handling is contained in here. */
@singleton()
export class S3MultipartStorage implements StoragePort {
  constructor(
    @inject(TOKENS.S3Client) private readonly s3: S3Client,
    @inject(AppConfig) private readonly config: AppConfig,
  ) {}

  async createMultipartUpload(input: {
    key: string;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<string> {
    try {
      const res = await this.s3.send(
        new CreateMultipartUploadCommand({
          Bucket: this.config.s3Bucket,
          Key: input.key,
          ContentType: input.contentType,
          Metadata: input.metadata,
          ServerSideEncryption: 'AES256',
        }),
      );
      if (!res.UploadId) throw new Error('S3 returned no UploadId');
      return res.UploadId;
    } catch (err) {
      throw this.wrap('CreateMultipartUpload', err);
    }
  }

  async presignUploadPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string> {
    try {
      // ContentLength is part of the signature: the client cannot upload a differently-sized body to this URL.
      return await getSignedUrl(
        this.s3,
        new UploadPartCommand({
          Bucket: this.config.s3Bucket,
          Key: input.key,
          UploadId: input.uploadId,
          PartNumber: input.partNumber,
          ContentLength: input.contentLength,
        }),
        { expiresIn: input.expiresInSeconds },
      );
    } catch (err) {
      throw this.wrap('PresignUploadPart', err);
    }
  }

  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    const parts: StoredPart[] = [];
    let marker: string | undefined;
    try {
      for (;;) {
        const res = await this.s3.send(
          new ListPartsCommand({
            Bucket: this.config.s3Bucket,
            Key: key,
            UploadId: uploadId,
            MaxParts: 1000,
            PartNumberMarker: marker,
          }),
        );
        for (const p of res.Parts ?? []) {
          if (p.PartNumber != null && p.Size != null && p.ETag) {
            parts.push({ partNumber: p.PartNumber, size: p.Size, etag: p.ETag });
          }
        }
        if (!res.IsTruncated) break;
        marker = res.NextPartNumberMarker;
        if (!marker) break;
      }
      return parts;
    } catch (err) {
      throw this.wrap('ListParts', err);
    }
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<Pick<StoredPart, 'partNumber' | 'etag'>>,
  ): Promise<void> {
    try {
      const res = await this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.s3Bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
      // S3 can answer HTTP 200 with an error body; the SDK surfaces most of those as thrown errors,
      // but a response with neither ETag nor Location is never a success.
      if (!res.ETag && !res.Location) throw new Error('CompleteMultipartUpload returned no ETag/Location');
    } catch (err) {
      throw this.wrap('CompleteMultipartUpload', err);
    }
  }

  async headObject(key: string): Promise<HeadResult | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.config.s3Bucket, Key: key }));
      return { size: res.ContentLength ?? 0, metadata: res.Metadata ?? {} };
    } catch (err) {
      const e = err as AwsLikeError;
      if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw this.wrap('HeadObject', err);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.s3.send(
        new AbortMultipartUploadCommand({ Bucket: this.config.s3Bucket, Key: key, UploadId: uploadId }),
      );
    } catch (err) {
      if ((err as AwsLikeError).name === 'NoSuchUpload') return; // already gone = goal achieved
      throw this.wrap('AbortMultipartUpload', err);
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.s3Bucket, Key: key }));
    } catch (err) {
      throw this.wrap('DeleteObject', err);
    }
  }

  private wrap(operation: string, err: unknown): Error {
    const e = err as AwsLikeError;
    if (e?.name === 'NoSuchUpload') return new StorageUploadMissingError(err);
    const status = e?.$metadata?.httpStatusCode;
    const retryable =
      (status !== undefined && (status >= 500 || status === 429 || status === 408)) ||
      (e?.name !== undefined && RETRYABLE_NAMES.has(e.name)) ||
      (e?.code !== undefined && RETRYABLE_CODES.has(e.code));
    return new StorageError(operation, retryable, err);
  }
}
