import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { singleton } from 'tsyringe';

type Ctx = Record<string, unknown>;

/** Thin wrapper so domain/application code never imports Nest directly and never logs secrets (URLs, tokens). */
@singleton()
export class AppLogger {
  private readonly logger = new Logger('Upload');

  info(message: string, ctx?: Ctx): void {
    this.logger.log(this.fmt(message, ctx));
  }

  warn(message: string, ctx?: Ctx): void {
    this.logger.warn(this.fmt(message, ctx));
  }

  error(message: string, err?: unknown, ctx?: Ctx): void {
    const e = err instanceof Error ? { name: err.name, message: err.message } : err;
    this.logger.error(this.fmt(message, { ...ctx, err: e }), err instanceof Error ? err.stack : undefined);
  }

  private fmt(message: string, ctx?: Ctx): string {
    return ctx ? `${message} ${JSON.stringify(ctx)}` : message;
  }
}
