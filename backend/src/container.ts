import 'reflect-metadata';
import { container, type DependencyContainer } from 'tsyringe';
import type { Provider, Type } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { AppConfig } from './common/config/app-config';
import { TOKENS } from './common/tokens';
import { PostgresUploadRepository } from './upload/infra/postgres-upload-repository';
import { S3MultipartStorage } from './upload/infra/s3-multipart-storage';

let configured = false;

/**
 * Composition root. The ONLY place that knows which concrete class backs which interface.
 * Swap S3MultipartStorage for a GCS/MinIO adapter, or the repository for another DB, here.
 */
export function configureContainer(): DependencyContainer {
  if (configured) return container;

  const config = container.resolve(AppConfig); // validates env eagerly: fail fast at boot

  container.registerInstance(
    TOKENS.PgPool,
    new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    }),
  );

  container.registerInstance(
    TOKENS.S3Client,
    new S3Client({
      region: config.awsRegion,
      endpoint: config.s3Endpoint,
      forcePathStyle: config.s3ForcePathStyle,
      maxAttempts: 3,
      // Browser PUTs to presigned URLs can't send the SDK's default CRC32 checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    }),
  );

  container.registerSingleton(TOKENS.UploadRepository, PostgresUploadRepository);
  container.registerSingleton(TOKENS.StoragePort, S3MultipartStorage);

  configured = true;
  return container;
}

/** Bridge: expose a tsyringe-managed class to Nest's injector, so controllers/guards can `@Inject(Class)`. */
export function fromContainer<T>(token: Type<T>): Provider<T> {
  return { provide: token, useFactory: () => container.resolve<T>(token) };
}
