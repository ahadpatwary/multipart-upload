import { PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { ValidationFailedError } from '../../common/errors/app-error';

export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationFailedError('Invalid request', { issues: result.error.flatten() });
    }
    return result.data;
  }
}
