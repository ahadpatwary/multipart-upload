import { ValidationFailedError } from '../../common/errors/app-error';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Hard S3 limits for general-purpose buckets. */
export const MIN_PART_SIZE = 5 * MiB;
export const MAX_PART_SIZE = 5 * GiB;
export const MAX_PARTS = 10_000;

export interface StoredPart {
  partNumber: number;
  size: number;
  etag: string;
}

export interface PartVerification {
  /** Parts S3 does not have at all. */
  missing: number[];
  /** Parts S3 has, but with the wrong size (truncated / tampered / wrong slice). */
  invalid: number[];
}

/**
 * Pure value object: deterministic mapping file size + part size <-> part numbers/byte lengths.
 * The SERVER decides part size; the client only follows it.
 */
export class PartPlan {
  private constructor(
    readonly fileSize: number,
    readonly partSize: number,
    readonly partCount: number,
  ) {}

  static create(fileSize: number, preferredPartSize: number): PartPlan {
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
      throw new ValidationFailedError('fileSize must be a positive integer');
    }
    const minForPartLimit = Math.ceil(fileSize / MAX_PARTS);
    let partSize = Math.max(preferredPartSize, MIN_PART_SIZE, minForPartLimit);
    partSize = Math.ceil(partSize / MiB) * MiB; // round up to whole MiB
    if (partSize > MAX_PART_SIZE) {
      throw new ValidationFailedError('File is too large for multipart upload limits');
    }
    return new PartPlan(fileSize, partSize, Math.ceil(fileSize / partSize));
  }

  static fromSession(s: { fileSize: number; partSize: number; expectedPartCount: number }): PartPlan {
    return new PartPlan(s.fileSize, s.partSize, s.expectedPartCount);
  }

  isValidPartNumber(n: number): boolean {
    return Number.isInteger(n) && n >= 1 && n <= this.partCount;
  }

  lengthOf(partNumber: number): number {
    if (!this.isValidPartNumber(partNumber)) throw new RangeError(`invalid part number ${partNumber}`);
    const start = (partNumber - 1) * this.partSize;
    return Math.min(this.partSize, this.fileSize - start);
  }

  verify(stored: readonly StoredPart[]): PartVerification {
    const byNumber = new Map(stored.map((p) => [p.partNumber, p]));
    const missing: number[] = [];
    const invalid: number[] = [];
    for (let n = 1; n <= this.partCount; n++) {
      const part = byNumber.get(n);
      if (!part) missing.push(n);
      else if (part.size !== this.lengthOf(n)) invalid.push(n);
    }
    return { missing, invalid };
  }
}
