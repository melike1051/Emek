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
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  AUTH_CONTACT_REQUIRED: 'AUTH_CONTACT_REQUIRED',
  IDENTITY_ALREADY_REGISTERED: 'IDENTITY_ALREADY_REGISTERED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  VERIFICATION_SESSION_EXPIRED: 'VERIFICATION_SESSION_EXPIRED',
  RECOVERY_NOT_ALLOWED: 'RECOVERY_NOT_ALLOWED',
  RECOVERY_REQUEST_NOT_PENDING: 'RECOVERY_REQUEST_NOT_PENDING',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  BOOKING_CONFLICT: 'BOOKING_CONFLICT',
  SELF_BOOKING_NOT_ALLOWED: 'SELF_BOOKING_NOT_ALLOWED',
  PROVIDER_NOT_AVAILABLE: 'PROVIDER_NOT_AVAILABLE',
  ADDRESS_NOT_FOUND: 'ADDRESS_NOT_FOUND',
  PROFILE_ALREADY_EXISTS: 'PROFILE_ALREADY_EXISTS',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  SKILL_ALREADY_ADDED: 'SKILL_ALREADY_ADDED',
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
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: HttpStatus.CONFLICT,
  [ErrorCode.IDEMPOTENCY_IN_PROGRESS]: HttpStatus.CONFLICT,
  [ErrorCode.VERIFICATION_REQUIRED]: HttpStatus.FORBIDDEN,
  [ErrorCode.AUTH_CONTACT_REQUIRED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.IDENTITY_ALREADY_REGISTERED]: HttpStatus.CONFLICT,
  [ErrorCode.VERIFICATION_FAILED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.VERIFICATION_SESSION_EXPIRED]: HttpStatus.CONFLICT,
  [ErrorCode.RECOVERY_NOT_ALLOWED]: HttpStatus.FORBIDDEN,
  [ErrorCode.RECOVERY_REQUEST_NOT_PENDING]: HttpStatus.CONFLICT,
  [ErrorCode.INVALID_STATE_TRANSITION]: HttpStatus.CONFLICT,
  [ErrorCode.BOOKING_CONFLICT]: HttpStatus.CONFLICT,
  [ErrorCode.SELF_BOOKING_NOT_ALLOWED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.PROVIDER_NOT_AVAILABLE]: HttpStatus.CONFLICT,
  [ErrorCode.ADDRESS_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.PROFILE_ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [ErrorCode.PROFILE_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.SKILL_ALREADY_ADDED]: HttpStatus.CONFLICT,
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
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]:
    'Bu istek anahtarı farklı bir içerikle kullanılmış. Yeni bir anahtarla tekrar deneyin.',
  [ErrorCode.IDEMPOTENCY_IN_PROGRESS]: 'Aynı istek hâlâ işleniyor, lütfen tekrar deneyin.',
  [ErrorCode.VERIFICATION_REQUIRED]: 'Bu işlem için hesabınızın doğrulanması gerekiyor.',
  [ErrorCode.AUTH_CONTACT_REQUIRED]:
    'Hesap oluşturmak için e-posta veya telefon bilgisi gerekiyor.',
  [ErrorCode.IDENTITY_ALREADY_REGISTERED]:
    'Bu kimlik başka bir hesapta doğrulanmış. Hesabınıza erişmek için kurtarma akışını kullanın.',
  [ErrorCode.VERIFICATION_FAILED]: 'Kimlik doğrulama tamamlanamadı.',
  [ErrorCode.VERIFICATION_SESSION_EXPIRED]:
    'Doğrulama oturumunun süresi doldu, lütfen yeniden başlatın.',
  [ErrorCode.RECOVERY_NOT_ALLOWED]:
    'Hesap kurtarma talebiniz otomatik olarak tamamlanamıyor, inceleme gerekiyor.',
  [ErrorCode.RECOVERY_REQUEST_NOT_PENDING]: 'Bu kurtarma talebi zaten karara bağlanmış.',
  [ErrorCode.INVALID_STATE_TRANSITION]: 'Bu işlem rezervasyonun mevcut durumunda yapılamaz.',
  [ErrorCode.BOOKING_CONFLICT]: 'Seçilen zaman aralığı artık uygun değil.',
  [ErrorCode.SELF_BOOKING_NOT_ALLOWED]: 'Kendi hizmetiniz için rezervasyon oluşturamazsınız.',
  [ErrorCode.PROVIDER_NOT_AVAILABLE]: 'Sağlayıcı seçilen zaman aralığında müsait değil.',
  [ErrorCode.ADDRESS_NOT_FOUND]: 'Adres bulunamadı.',
  [ErrorCode.PROFILE_ALREADY_EXISTS]: 'Bu profil zaten oluşturulmuş.',
  [ErrorCode.PROFILE_NOT_FOUND]: 'Profil bulunamadı.',
  [ErrorCode.SKILL_ALREADY_ADDED]: 'Bu yetkinlik profilinizde zaten var.',
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
