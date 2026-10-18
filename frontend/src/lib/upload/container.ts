import 'reflect-metadata';
import { container, type DependencyContainer } from 'tsyringe';
import { RetryPolicy } from './retry-policy';
import { UPLOAD_TOKENS, type AuthTokenProvider } from './tokens';

/** Replace with your real session/auth integration. */
export class LocalStorageTokenProvider implements AuthTokenProvider {
  async getToken(): Promise<string> {
    return globalThis.localStorage?.getItem('access_token') ?? '';
  }
}

export interface UploadContainerOverrides {
  apiBaseUrl?: string;
  authTokenProvider?: AuthTokenProvider;
}

let configured = false;

/** Composition root for the upload feature. Idempotent; call from the hook (client-side only). */
export function configureUploadContainer(overrides: UploadContainerOverrides = {}): DependencyContainer {
  if (configured) return container;

  container.registerInstance(
    UPLOAD_TOKENS.ApiBaseUrl,
    overrides.apiBaseUrl ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000',
  );
  container.registerInstance<AuthTokenProvider>(
    UPLOAD_TOKENS.AuthTokenProvider,
    overrides.authTokenProvider ?? new LocalStorageTokenProvider(),
  );
  // Per-chunk retry: up to 5 attempts, ~0.5s → 15s ceilings, full jitter.
  container.registerInstance(
    UPLOAD_TOKENS.PartRetryPolicy,
    new RetryPolicy({ maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 15_000 }),
  );
  // Control-plane: quicker and shorter, so it doesn't multiply with the part-level retries.
  container.registerInstance(
    UPLOAD_TOKENS.ApiRetryPolicy,
    new RetryPolicy({ maxAttempts: 3, baseDelayMs: 300, maxDelayMs: 4_000 }),
  );

  configured = true;
  return container;
}
