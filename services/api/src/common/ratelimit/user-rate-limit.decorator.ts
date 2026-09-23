import { SetMetadata } from '@nestjs/common';

export const USER_RATE_LIMIT_KEY = 'emek:user-rate-limit';

export interface UserRateLimitOptions {
  /** Sayaç anahtarının ayırt edici parçası; farklı endpoint'ler aynı kotayı paylaşmaz. */
  name: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Kimlik doğrulanmış **kullanıcı başına** oran sınırı.
 *
 * IP bazlı sınır (`@RateLimit`) kimlik doğrulama maliyetini korur ama Cloud Run
 * arkasında paylaşılan bir kovadır: tek bir kötü niyetli hesap, bütün meşru
 * kullanıcıların kotasını tüketebilir. Bu dekoratör pahalı ve suistimale açık
 * yazma uçlarında hesabı kendi kotasına bağlar.
 */
export const UserRateLimit = (options: UserRateLimitOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(USER_RATE_LIMIT_KEY, options);
