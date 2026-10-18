import {
  Body,
  Controller,
  createParamDecorator,
  ExecutionContext,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UploadService } from '../application/upload-service';
import { JwtAuthGuard, type AuthenticatedRequest } from './jwt-auth.guard';
import {
  idempotencyKeySchema,
  initiateSchema,
  presignSchema,
  uuidSchema,
  type InitiateBody,
  type PresignBody,
} from './schemas';
import { ZodValidationPipe } from './zod-validation.pipe';

const CurrentUserId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest<AuthenticatedRequest>().user.id;
});

const IdParam = () => Param('id', new ZodValidationPipe(uuidSchema));

/** Thin: parse/validate -> delegate -> return. No business logic here. */
@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(@Inject(UploadService) private readonly uploads: UploadService) {}

  @Post()
  @HttpCode(201)
  initiate(
    @CurrentUserId() userId: string,
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(initiateSchema)) body: InitiateBody,
  ) {
    const idempotencyKey = new ZodValidationPipe(idempotencyKeySchema).transform(rawIdempotencyKey);
    return this.uploads.initiate(userId, body, idempotencyKey);
  }

  @Get(':id')
  status(@CurrentUserId() userId: string, @IdParam() id: string) {
    return this.uploads.getStatus(userId, id);
  }

  @Post(':id/parts/presign')
  @HttpCode(200)
  async presign(
    @CurrentUserId() userId: string,
    @IdParam() id: string,
    @Body(new ZodValidationPipe(presignSchema)) body: PresignBody,
  ) {
    return { urls: await this.uploads.presignParts(userId, id, body.partNumbers) };
  }

  @Post(':id/complete')
  @HttpCode(200)
  async complete(@CurrentUserId() userId: string, @IdParam() id: string) {
    return { session: await this.uploads.complete(userId, id) };
  }

  @Post(':id/abort')
  @HttpCode(200)
  async abort(@CurrentUserId() userId: string, @IdParam() id: string) {
    return { session: await this.uploads.abort(userId, id) };
  }
}
