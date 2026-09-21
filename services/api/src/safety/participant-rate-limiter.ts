import { Injectable } from '@nestjs/common';

/**
 * Kimliği doğrulanmış kullanıcı başına, süreç içi sabit pencere oran sınırı.
 *
 * Neden global `RateLimitGuard` değil (Faz 8 review bulgusu H1): o guard kimlik
 * doğrulamadan **önce** çalışır ve IP'ye göre sayar. Cloud Run arkasında tüm istekler
 * tek adresten görünür (R-53); telemetri ucunda bu, kimliksiz bir saldırganın ortak
 * kovayı doldurup **tüm** sağlayıcıların telemetrisini 429'la kesmesi ve her aktif
 * oturumda sahte "telemetri kesildi" alarmı üretmesi demekti. Burada sayaç kimlik
 * doğrulandıktan sonra ve kullanıcıya göre tutulur: bir kullanıcı yalnızca kendini
 * sınırlayabilir.
 *
 * Bilinçli olarak Redis kullanmaz: sınırın erişilemezliği güvenlik telemetrisini ya
 * da paniği etkilememeli. Sınır instance başınadır (N instance → N katı); kalıcı ve
 * instance'tan bağımsız koruma veritabanındaki sıra/aralık kontrolüdür (R-66).
 */
@Injectable()
export class ParticipantRateLimiter {
  private readonly buckets = new Map<string, { expiresAt: number; count: number }>();
  private lastSweep = 0;

  /** İzin verildiyse true. `now` test içindir. */
  consume(key: string, limit: number, windowSeconds: number, now = Date.now()): boolean {
    this.sweep(now);

    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.expiresAt <= now) {
      const windowMs = windowSeconds * 1000;
      this.buckets.set(key, { expiresAt: (Math.floor(now / windowMs) + 1) * windowMs, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }

  /** Süresi dolmuş kovaları düşürür: bellek, etkin kullanıcı sayısıyla sınırlı kalır. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) {
      return;
    }
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
