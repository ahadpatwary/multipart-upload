import 'reflect-metadata';
import { inject, injectable } from 'tsyringe';
import { PartUploader } from './part-uploader';
import { ResumeStore } from './resume-store';
import { RetryPolicy } from './retry-policy';
import { UPLOAD_TOKENS } from './tokens';
import { UploadApi } from './upload-api';
import { UploadTask } from './upload-task';
import type { UploadOptions } from './types';

/** Factory for UploadTasks; the only thing UI code needs to resolve from the container. */
@injectable()
export class MultipartUploadService {
  constructor(
    @inject(UploadApi) private readonly api: UploadApi,
    @inject(PartUploader) private readonly uploader: PartUploader,
    @inject(ResumeStore) private readonly store: ResumeStore,
    @inject(UPLOAD_TOKENS.PartRetryPolicy) private readonly partRetry: RetryPolicy,
  ) {}

  createTask(file: File, options: UploadOptions = {}): UploadTask {
    return new UploadTask(
      file,
      { api: this.api, uploader: this.uploader, store: this.store, partRetry: this.partRetry },
      options,
      ResumeStore.fingerprint(file),
    );
  }
}
