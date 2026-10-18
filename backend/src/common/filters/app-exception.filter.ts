import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppLogger } from '../logger';
import { AppError } from '../errors/app-error';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

/** Single place that turns any thrown value into the JSON error envelope the frontend understands. */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? undefined;

    let status = 500;
    let body: ErrorBody;

    if (exception instanceof AppError) {
      status = exception.httpStatus;
      body = {
        error: {
          code: exception.code,
          message: exception.message,
          retryable: exception.retryable,
          details: exception.details,
          requestId,
        },
      };
      if (status >= 500) this.logger.error(`${exception.code} on ${req.method} ${req.path}`, exception, { requestId });
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = {
        error: {
          code: status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR',
          message: exception.message,
          retryable: status === 429 || status >= 500,
          requestId,
        },
      };
    } else {
      // Unknown: never leak internals to the client.
      this.logger.error(`Unhandled error on ${req.method} ${req.path}`, exception, { requestId });
      body = {
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error', retryable: true, requestId },
      };
    }

    res.status(status).json(body);
  }
}
