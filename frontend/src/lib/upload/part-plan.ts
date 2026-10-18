import type { UploadedPart } from './types';

/** Client mirror of the server's PartPlan: byte ranges are derived, never stored. */
export class PartPlan {
  constructor(
    readonly fileSize: number,
    readonly partSize: number,
    readonly partCount: number,
  ) {}

  rangeOf(partNumber: number): { start: number; end: number } {
    if (partNumber < 1 || partNumber > this.partCount) throw new RangeError(`invalid part ${partNumber}`);
    const start = (partNumber - 1) * this.partSize;
    return { start, end: Math.min(start + this.partSize, this.fileSize) };
  }

  lengthOf(partNumber: number): number {
    const { start, end } = this.rangeOf(partNumber);
    return end - start;
  }

  /** Part numbers that are NOT confirmed (by size) in the server's list. */
  missing(uploaded: readonly UploadedPart[]): number[] {
    const ok = new Set(uploaded.filter((p) => p.size === this.lengthOf(p.partNumber)).map((p) => p.partNumber));
    const out: number[] = [];
    for (let n = 1; n <= this.partCount; n++) if (!ok.has(n)) out.push(n);
    return out;
  }
}
