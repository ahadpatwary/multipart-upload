import 'reflect-metadata';
import { singleton } from 'tsyringe';

export interface ResumeRecord {
  /** Persisted BEFORE the initiate call, so a lost response can't create a second session. */
  idempotencyKey: string;
  sessionId?: string;
  savedAt: number;
}

const PREFIX = 'mpu:v1:';

/**
 * Remembers {idempotencyKey, sessionId} per file so a reload/crash can resume.
 * Only a HINT: progress truth always comes from the server (which asks S3). Never stores file bytes.
 */
@singleton()
export class ResumeStore {
  private readonly memory = new Map<string, ResumeRecord>();

  /** name+size+lastModified. Cheap; wrong-file collisions are caught by the server-side size check. */
  static fingerprint(file: File): string {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }

  load(fingerprint: string): ResumeRecord | null {
    const mem = this.memory.get(fingerprint);
    if (mem) return mem;
    try {
      const raw = globalThis.localStorage?.getItem(PREFIX + fingerprint);
      return raw ? (JSON.parse(raw) as ResumeRecord) : null;
    } catch {
      return null;
    }
  }

  save(fingerprint: string, record: ResumeRecord): void {
    this.memory.set(fingerprint, record);
    try {
      globalThis.localStorage?.setItem(PREFIX + fingerprint, JSON.stringify(record));
    } catch {
      /* private mode / quota: in-memory copy still works for this tab */
    }
  }

  clear(fingerprint: string): void {
    this.memory.delete(fingerprint);
    try {
      globalThis.localStorage?.removeItem(PREFIX + fingerprint);
    } catch {
      /* ignore */
    }
  }
}
