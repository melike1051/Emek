import { HttpStatus } from '@nestjs/common';

/**
 * Business error kodları — docs/api/error-codes.md ile aynı listedir.
 * Kod adı kararlıdır: anlamı değişirse yeni kod eklenir, eskisi yeniden kullanılmaz.
 *
 * Faz 1'de yalnızca altyapı seviyesindeki kodlar tanımlıdır; domain kodları
 * ilgili fazda (kendi modülleriyle birlikte) eklenir.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_DEGRADED: 'SERVICE_DEGRADED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Her kodun tek bir HTTP karşılığı vardır; eşleme tek yerde tutulur. */
export const ERROR_STATUS: Record<ErrorCodeValue, HttpStatus> = {
  [ErrorCode.VALIDATION_FAILED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.RATE_LIMITED]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.SERVICE_DEGRADED]: HttpStatus.SERVICE_UNAVAILABLE,
  [ErrorCode.INTERNAL_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * BusinessException dışındaki hatalarda istemciye dönen sabit mesajlar.
 * Mesaj asla framework/exception içeriğinden türetilmez: "Cannot GET /api/v1/x" gibi
 * iç detaylar sözleşmeye ait değildir ve istemci koda göre kendi metnini gösterir.
 */
export const CLIENT_MESSAGES: Record<ErrorCodeValue, string> = {
  [ErrorCode.VALIDATION_FAILED]: 'İstek doğrulanamadı.',
  [ErrorCode.UNAUTHENTICATED]: 'Oturum doğrulanamadı.',
  [ErrorCode.FORBIDDEN]: 'Bu işlem için yetkiniz yok.',
  [ErrorCode.NOT_FOUND]: 'Kaynak bulunamadı.',
  [ErrorCode.RATE_LIMITED]: 'Çok fazla istek gönderildi, lütfen sonra tekrar deneyin.',
  [ErrorCode.SERVICE_DEGRADED]: 'Servis şu anda tam kapasiteyle çalışmıyor.',
  [ErrorCode.INTERNAL_ERROR]: 'Beklenmeyen bir hata oluştu.',
};

/** HTTP status → kod (framework'ün ürettiği HttpException'ları kodlu yanıta çevirmek için). */
export function errorCodeForStatus(status: number): ErrorCodeValue {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.VALIDATION_FAILED;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.UNAUTHENTICATED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.NOT_FOUND;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCode.RATE_LIMITED;
    case HttpStatus.SERVICE_UNAVAILABLE:
      return ErrorCode.SERVICE_DEGRADED;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}
