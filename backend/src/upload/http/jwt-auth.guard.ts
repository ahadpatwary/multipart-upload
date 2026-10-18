import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { AppConfig } from '../../common/config/app-config';
import { UnauthorizedError } from '../../common/errors/app-error';

export interface AuthenticatedRequest extends Request {
  user: { id: string };
}

/**
 * Minimal HS256 bearer-token guard so the module is runnable on its own.
 * In your real app, replace the verify step with your existing auth (same `request.user.id` contract).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('Missing bearer token');

    try {
      const payload = jwt.verify(header.slice(7), this.config.jwtSecret, { algorithms: ['HS256'] });
      const sub = typeof payload === 'object' ? payload.sub : undefined;
      if (!sub) throw new Error('no sub');
      req.user = { id: sub };
      return true;
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }
  }
}
