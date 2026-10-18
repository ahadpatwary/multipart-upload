import { z } from 'zod';

export const initiateSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive(),
  contentType: z.string().min(3).max(127).regex(/^[\w.+-]+\/[\w.+-]+$/, 'invalid content type'),
  partSize: z.number().int().positive().optional(),
});

export const presignSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(200),
});

export const uuidSchema = z.string().uuid();

export const idempotencyKeySchema = z
  .string({ required_error: 'Idempotency-Key header is required' })
  .min(8)
  .max(128)
  .regex(/^[\w.:-]+$/, 'invalid Idempotency-Key');

export type InitiateBody = z.infer<typeof initiateSchema>;
export type PresignBody = z.infer<typeof presignSchema>;
