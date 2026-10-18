import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { AppConfig } from './common/config/app-config';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { AppLogger } from './common/logger';
import { TOKENS } from './common/tokens';
import { configureContainer } from './container';
import { UploadMaintenanceWorker } from './upload/application/upload-maintenance-worker';

async function bootstrap(): Promise<void> {
  const di = configureContainer();
  const config = di.resolve(AppConfig);
  const logger = di.resolve(AppLogger);

  const app = await NestFactory.create(AppModule);
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  });

  app.enableCors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });
  app.useGlobalFilters(new AppExceptionFilter(logger));

  await app.listen(config.port);
  logger.info(`API listening on :${config.port}`);

  const worker = di.resolve(UploadMaintenanceWorker);
  if (config.enableEmbeddedWorker) worker.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    await worker.stop();
    await app.close();
    await di.resolve<Pool>(TOKENS.PgPool as never).end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error', err);
  process.exit(1);
});
