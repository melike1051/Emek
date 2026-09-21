import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'emek:rate-limit';

export interface RateLimitOptions {
  /** Sayaç anahtarının ayırt edici parçası; farklı endpoint'ler aynı kotayı paylaşmaz. */
  name: string;
  limit: number;
  windowSeconds: number;
}

/** Endpoint veya controller bazında oran sınırı uygular. */
export const RateLimit = (options: RateLimitOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, options);
