import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'emek:rate-limit';

export interface RateLimitOptions {
  /** Sayaç anahtarının ayırt edici parçası; farklı endpoint'ler aynı kotayı paylaşmaz. */
  name: string;
  limit: number;
  windowSeconds: number;
  /**
   * Sayaç okunamadığında (Redis erişilemez) isteği **geçir**.
   *
   * Varsayılan fail-closed'dır (ADR-0003) ve öyle kalmalıdır. İstisna yalnızca
   * kalıcı katmanda ayrı bir koruması olan ve reddedilmesi **güvenliği azaltan**
   * uçlar içindir: güvenlik telemetrisi Redis kesintisinde reddedilseydi her aktif
   * oturum "telemetri kesildi" alarmı üretirdi ve gerçek alarm gürültüde kaybolurdu.
   * Telemetrinin kalıcı koruması oturum başına sıra/aralık kontrolüdür (ADR-0019 §3).
   */
  failOpen?: boolean;
}

/** Endpoint veya controller bazında oran sınırı uygular. */
export const RateLimit = (options: RateLimitOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, options);
