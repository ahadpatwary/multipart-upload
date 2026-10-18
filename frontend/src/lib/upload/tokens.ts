export const UPLOAD_TOKENS = {
  ApiBaseUrl: Symbol('UploadApiBaseUrl'),
  AuthTokenProvider: Symbol('UploadAuthTokenProvider'),
  /** Policy for each part PUT to S3 (per-chunk retry). */
  PartRetryPolicy: Symbol('UploadPartRetryPolicy'),
  /** Policy for control-plane calls to our API. */
  ApiRetryPolicy: Symbol('UploadApiRetryPolicy'),
} as const;

/** Plug your real auth in here (NextAuth session, cookie-less JWT, etc.). Called before EVERY request. */
export interface AuthTokenProvider {
  getToken(): Promise<string>;
}
