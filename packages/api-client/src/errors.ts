/**
 * Backend hata sözleşmesi (docs/api/error-codes.md):
 * `{ "error": { "code", "message", "requestId", "details" } }`.
 * `message` kullanıcıya gösterilebilir güvenli metindir; istemci kendi metnini uydurmaz.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

/** Ağ kesintisi / sözleşme dışı yanıt için istemci tarafı kodlar. */
export const CLIENT_ERROR_CODES = {
  NETWORK: 'NETWORK_ERROR',
  UNEXPECTED_RESPONSE: 'UNEXPECTED_RESPONSE',
  /** İmzalı URL'e yükleme reddedildi (süre dolmuş olabilir) — yeniden kayıtla denenir. */
  UPLOAD_FAILED: 'UPLOAD_FAILED',
} as const;

const FALLBACK_MESSAGES: Record<string, string> = {
  [CLIENT_ERROR_CODES.NETWORK]: 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.',
  [CLIENT_ERROR_CODES.UNEXPECTED_RESPONSE]: 'Beklenmeyen bir yanıt alındı. Lütfen tekrar deneyin.',
  [CLIENT_ERROR_CODES.UPLOAD_FAILED]: 'Dosya yüklenemedi. Lütfen tekrar deneyin.',
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.requestId = body.requestId;
    this.details = body.details;
  }

  static client(
    code: (typeof CLIENT_ERROR_CODES)[keyof typeof CLIENT_ERROR_CODES],
    status = 0,
  ): ApiError {
    return new ApiError(status, { code, message: FALLBACK_MESSAGES[code] ?? code });
  }

  /** Oturum geçersiz → yeniden giriş gerekir. */
  get isUnauthenticated(): boolean {
    return this.status === 401 && this.code === 'UNAUTHENTICATED';
  }

  /** Tekrar denemek anlamlı mı? (ağ, oran sınırı, geçici bozulma) */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status === 503;
  }
}

export function isApiErrorBody(value: unknown): value is { error: ApiErrorBody } {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const error = (value as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as ApiErrorBody).code === 'string' &&
    typeof (error as ApiErrorBody).message === 'string'
  );
}
