import 'reflect-metadata';
import type { Pool } from 'pg';
import { AppLogger } from './common/logger';
import { TOKENS } from './common/tokens';
import { configureContainer } from './container';
import { UploadMaintenanceWorker } from './upload/application/upload-maintenance-worker';

/** Standalone worker process (recommended in production so API scaling and reconciliation are independent). */
async function main(): Promise<void> {
  const di = configureContainer();
  const logger = di.resolve(AppLogger);
  const worker = di.resolve(UploadMaintenanceWorker);
  worker.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received, stopping worker`);
    await worker.stop();
    await di.resolve<Pool>(TOKENS.PgPool as never).end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal worker error', err);
  process.exit(1);
});
