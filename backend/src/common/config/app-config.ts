import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { z } from 'zod';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  AWS_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: bool.default('false'),
  S3_KEY_PREFIX: z.string().default('private-uploads'),

  MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().default(50 * GiB),
  DEFAULT_QUOTA_BYTES: z.coerce.number().int().nonnegative().default(50 * GiB),
  DEFAULT_PART_SIZE_BYTES: z.coerce.number().int().positive().default(128 * MiB),
  PRESIGN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).default(24 * 3600),
  MAX_ACTIVE_UPLOADS_PER_USER: z.coerce.number().int().positive().default(3),
  MAX_PRESIGN_BATCH: z.coerce.number().int().positive().max(200).default(50),
  COMPLETING_LEASE_SECONDS: z.coerce.number().int().min(30).default(120),
  ALLOWED_CONTENT_TYPE_PREFIXES: z.string().default('video/,audio/'),

  ENABLE_EMBEDDED_WORKER: bool.default('true'),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
});

@singleton()
export class AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly corsOrigins: string[];

  readonly awsRegion: string;
  readonly s3Bucket: string;
  readonly s3Endpoint?: string;
  readonly s3ForcePathStyle: boolean;
  readonly s3KeyPrefix: string;

  readonly maxFileSizeBytes: number;
  readonly defaultQuotaBytes: number;
  readonly defaultPartSizeBytes: number;
  readonly presignTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly maxActiveUploadsPerUser: number;
  readonly maxPresignBatch: number;
  readonly completingLeaseSeconds: number;
  readonly allowedContentTypePrefixes: string[];

  readonly enableEmbeddedWorker: boolean;
  readonly workerIntervalMs: number;
  readonly workerBatchSize: number;

  constructor() {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    const e = parsed.data;
    this.nodeEnv = e.NODE_ENV;
    this.port = e.PORT;
    this.databaseUrl = e.DATABASE_URL;
    this.jwtSecret = e.JWT_SECRET;
    this.corsOrigins = e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

    this.awsRegion = e.AWS_REGION;
    this.s3Bucket = e.S3_BUCKET;
    this.s3Endpoint = e.S3_ENDPOINT;
    this.s3ForcePathStyle = e.S3_FORCE_PATH_STYLE;
    this.s3KeyPrefix = e.S3_KEY_PREFIX.replace(/^\/+|\/+$/g, '');

    this.maxFileSizeBytes = e.MAX_FILE_SIZE_BYTES;
    this.defaultQuotaBytes = e.DEFAULT_QUOTA_BYTES;
    this.defaultPartSizeBytes = e.DEFAULT_PART_SIZE_BYTES;
    this.presignTtlSeconds = e.PRESIGN_TTL_SECONDS;
    this.sessionTtlSeconds = e.SESSION_TTL_SECONDS;
    this.maxActiveUploadsPerUser = e.MAX_ACTIVE_UPLOADS_PER_USER;
    this.maxPresignBatch = e.MAX_PRESIGN_BATCH;
    this.completingLeaseSeconds = e.COMPLETING_LEASE_SECONDS;
    this.allowedContentTypePrefixes = e.ALLOWED_CONTENT_TYPE_PREFIXES.split(',').map((s) => s.trim()).filter(Boolean);

    this.enableEmbeddedWorker = e.ENABLE_EMBEDDED_WORKER;
    this.workerIntervalMs = e.WORKER_INTERVAL_MS;
    this.workerBatchSize = e.WORKER_BATCH_SIZE;
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
}
