import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { POSTGRES_POOL } from '../common/database/database.tokens';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import { AppConfigService } from '../common/config/app-config.service';
import { PaymentsService } from './payments.service';

/**
 * Zamanlanmış ödeme serbest bırakma (R-42, ADR-0010 §9).
 *
 * Uyuşmazlık penceresi geçmiş, serbest bırakılabilir durumda olan ödemeleri bulur
 * ve `PaymentsService.release()` ile serbest bırakır. Mevcut release guard'ları
 * (dispute, safety hold, frozen, authorization expiry) aynen korunur — bu worker
 * yalnızca tetikleyicidir, karar mekanizması PaymentsService'tedir.
 *
 * İdempotency: `release()` zaten durumu kontrol eder; aynı ödeme iki kez serbest
 * bırakılamaz. Aday sorgusundaki `FOR UPDATE SKIP LOCKED`, tek bir `pool.query()`
 * çağrısı içinde çalıştığı için kilidi sorgu bitince bırakır — çakışan iki tick
 * (veya iki instance) aynı adayı seçebilir. Gerçek koruma `PaymentsService.release()`
 * içindeki `findByIdLocked` satır kilidindendir (Faz 2'nin outbox `claimBatch`'inden
 * farklı olarak burada sahiplenme ile durum değişikliği aynı ifadede değildir —
 * bilinçli: aday sorgusu yalnızca havuzu daraltır, kesin karar release()'tedir).
 *
 * Başlatma koşulu: `SCHEDULED_RELEASE_ENABLED=true` (varsayılan `false`).
 */
@Injectable()
export class ScheduledReleaseWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly disputeWindowHours: number;

  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly config: AppConfigService,
    private readonly payments: PaymentsService,
  ) {
    this.enabled = config.env.SCHEDULED_RELEASE_ENABLED ?? false;
    this.intervalMs = config.env.SCHEDULED_RELEASE_INTERVAL_MS ?? 60_000;
    this.disputeWindowHours = config.env.SCHEDULED_RELEASE_DISPUTE_WINDOW_HOURS ?? 48;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.info('Zamanlanmış ödeme release devre dışı (SCHEDULED_RELEASE_ENABLED=false)');
      return;
    }
    this.logger.info(
      { intervalMs: this.intervalMs, disputeWindowHours: this.disputeWindowHours },
      'Zamanlanmış ödeme release worker başlatılıyor',
    );
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'Zamanlanmış release turu başarısız');
        })
        .finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Tek bir release turu. Testler bunu doğrudan çağırabilir. */
  async tick(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;

    try {
      // Uyuşmazlık penceresi geçmiş, yetkilendirmesi canlı, serbest bırakılabilir
      // durumda olan ödemeleri bul.
      //
      // Koşullar:
      // 1. Ödeme SERVICE_COMPLETED veya RELEASE_PENDING durumunda
      // 2. İlişkili booking COMPLETED durumunda (hizmet tamamlanmış)
      // 3. Uyuşmazlık penceresi geçmiş (booking completed_at + dispute_window < now)
      // 4. Yetkilendirme süresi dolmamış
      // 5. Açık dispute yok (payment status DISPUTED değil)
      //
      // Guard'ların büyük bölümü PaymentsService.release() içinde de kontrol edilir;
      // buradaki sorgu yalnızca **aday havuzunu** daraltır — kesin karar release()'tedir.
      const candidates = await this.pool.query<{ id: string }>(
        `SELECT p.id
           FROM payments p
           JOIN bookings b ON b.id = p.booking_id
          WHERE p.status IN ('SERVICE_COMPLETED', 'RELEASE_PENDING')
            AND b.status = 'COMPLETED'
            AND b.updated_at + ($1 || ' hours')::interval < now()
            AND (p.authorization_expires_at IS NULL OR p.authorization_expires_at > now())
          ORDER BY b.updated_at ASC
          LIMIT 50
          FOR UPDATE OF p SKIP LOCKED`,
        [String(this.disputeWindowHours)],
      );

      if (candidates.rows.length === 0) {
        return 0;
      }

      this.logger.info(
        { candidateCount: candidates.rows.length },
        'Zamanlanmış release adayları bulundu',
      );

      let released = 0;
      for (const row of candidates.rows) {
        try {
          await this.payments.release({ paymentId: row.id });
          released += 1;
        } catch (error) {
          // Bireysel başarısızlık diğer adayları engellemez.
          // Guard hatası (dispute, frozen vb.) beklenen bir durumdur:
          // aday sorgusu ile release arası durumun değişmesi mümkündür.
          this.logger.warn(
            { paymentId: row.id, err: error instanceof Error ? error.message : String(error) },
            'Zamanlanmış release başarısız — ödeme atlanıyor',
          );
        }
      }

      this.logger.info(
        { released, attempted: candidates.rows.length },
        'Zamanlanmış release turu tamamlandı',
      );

      return released;
    } finally {
      this.running = false;
    }
  }
}
