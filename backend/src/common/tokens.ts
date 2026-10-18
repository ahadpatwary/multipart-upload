/** DI tokens for things that are interfaces / third-party instances (classes are their own token). */
export const TOKENS = {
  PgPool: Symbol('PgPool'),
  S3Client: Symbol('S3Client'),
  UploadRepository: Symbol('UploadRepository'),
  StoragePort: Symbol('StoragePort'),
} as const;
