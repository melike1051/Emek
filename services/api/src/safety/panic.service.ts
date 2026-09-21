import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import { BookingsService } from '../bookings/bookings.service';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { AppConfigService } from '../common/config/app-config.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import { EventType, OutboxService } from '../common/outbox/outbox.service';
import { EMERGENCY_NOTIFIER, type EmergencyNotifier } from './emergency-notifier.port';
import { SafetyMetrics } from './safety-metrics';
import { SafetyRepository, isPanicActive } from './safety.repository';

export const PANIC_CATEGORIES = ['THREAT', 'HEALTH', 'OTHER'] as const;
export type PanicCategory = (typeof PANIC_CATEGORIES)[number];

export interface PanicResult {
  sessionId: string;
  bookingId: string;
  eventId: string;
  raisedAt: Date;
  /** Oturumda panik zaten kayıtlıydı: bu çağrı yan etki üretmedi. */
  duplicate: boolean;
  /** Rezervasyon askıya alındı mı (ödeme serbest bırakma bloklandı mı). */
  bookingHoldApplied: boolean;
}

/** PostgreSQL deadlock ve serileştirme hataları — yeniden denenir. */
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);
const MAX_ATTEMPTS = 3;

/** Commit sonrası bildirim çağrısının üst sınırı. */
const NOTIFY_TIMEOUT_MS = 2000;

/**
 * Panik / acil durum yolu (ADR-0008 §3, ADR-0019 §8).
 *
 * **Deterministik ve anlıktır.** Bağımlılığı yalnızca PostgreSQL'dir:
 *
 * - Anomali modeli, rota servisi, Redis ve Pub/Sub **çağrılmaz**. Oran sınırı
 *   guard'ı (Redis, fail-closed) bu uca **takılmaz**: Redis kesintisi paniği
 *   bloklamamalı. Kötüye kullanım koruması oturum başına tekilliktir.
 * - Olay, oturum durumu (`EMERGENCY`), rezervasyon askısı (`SAFETY_HOLD` → ödeme
 *   donar), audit ve outbox (`SafetyAlertRaised`) **tek transaction'da** yazılır.
 *   Commit edildiyse alarm kalıcıdır ve yayını at-least-once garantilidir.
 * - Zaman damgası **sunucunundur**; istemci "ne zaman bastım" diyemez.
 * - Tekrar basış yan etki üretmez: **etkin** bir panik varken yeni olay yazılmaz
 *   (oturum kilidi + `(session, panicNumber)` unique index). Operatör acil durumu
 *   çözdükten sonra yeni panik yeniden kabul edilir — ilk yanlış alarm, aynı
 *   hizmetteki gerçek bir acil durumu yutmamalı.
 *
 * Kilit sırası booking → oturum'dur; booking geçişleri (check-out) de aynı sırayı
 * izler. Ters sıra, eşzamanlı bir check-out ile deadlock üretip paniği düşürebilirdi.
 * Yine de deadlock/serileştirme hatası olursa işlem yeniden denenir.
 *
 * Rezervasyon askıya alınamazsa (durum makinesi izin vermiyorsa) panik **yine
 * kaydedilir**: askı bir savepoint içinde denenir ve başarısızlığı olaya yazılır.
 * Acil durum kaydı, rezervasyon durumunun insafına bırakılmaz.
 */
@Injectable()
export class PanicService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repository: SafetyRepository,
    private readonly bookings: BookingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
    private readonly metrics: SafetyMetrics,
    @Inject(EMERGENCY_NOTIFIER) private readonly notifier: EmergencyNotifier,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async raise(input: {
    sessionId: string;
    userId: string;
    category: PanicCategory | null;
  }): Promise<PanicResult> {
    const started = Date.now();

    let result: (PanicResult & { raisedBy: 'PROVIDER' | 'CUSTOMER' }) | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        result = await this.uow.withTransaction((client) => this.persist(client, input));
        break;
      } catch (error) {
        if (attempt < MAX_ATTEMPTS && isRetryable(error)) {
          this.logger.warn({ attempt }, 'panik transaction yeniden deneniyor');
          continue;
        }
        throw error;
      }
    }
    if (result === undefined) {
      throw new Error('panik kaydedilemedi');
    }

    const latencyMs = Date.now() - started;
    this.metrics.record('safety.panic.raised', {
      sessionId: result.sessionId,
      duplicate: result.duplicate,
      bookingHoldApplied: result.bookingHoldApplied,
      latencyMs,
    });

    if (!result.duplicate) {
      // Commit **sonrası**, yanıtı bekletmeden. Kayıt zaten kalıcıdır; bildirim
      // hızlandırıcıdır ve hatası paniği geri almaz.
      this.notifyInBackground(result, input.category);
    }

    return {
      sessionId: result.sessionId,
      bookingId: result.bookingId,
      eventId: result.eventId,
      raisedAt: result.raisedAt,
      duplicate: result.duplicate,
      bookingHoldApplied: result.bookingHoldApplied,
    };
  }

  private async persist(
    client: PoolClient,
    input: { sessionId: string; userId: string; category: PanicCategory | null },
  ): Promise<PanicResult & { raisedBy: 'PROVIDER' | 'CUSTOMER' }> {
    // Kilitsiz ön okuma: rezervasyon (kilit sırası için) ve aynı kişinin etkin
    // paniği. Tekrar basış kilit almadan döner: aksi hâlde yüzlerce eşzamanlı tekrar
    // aynı satır kilidinde havuz bağlantısı tutup başkalarının paniğini bekletirdi.
    const lookup = await client.query<{
      booking_id: string;
      provider_id: string;
      status: string;
      panic_raised_at: Date | null;
      emergency_resolved_at: Date | null;
    }>(
      `SELECT booking_id, provider_id, status, panic_raised_at, emergency_resolved_at
         FROM safety_sessions
        WHERE id = $1 AND (provider_id = $2 OR customer_id = $2)`,
      [input.sessionId, input.userId],
    );
    const preview = lookup.rows[0];
    if (preview === undefined) {
      // Taraf olmayan ile var olmayan oturum aynı yanıtı alır.
      throw new BusinessException(ErrorCode.SAFETY_SESSION_NOT_FOUND);
    }
    const raisedBy = preview.provider_id === input.userId ? 'PROVIDER' : 'CUSTOMER';

    const early = await this.findOwnActivePanic(client, input.sessionId, input.userId, {
      panicRaisedAt: preview.panic_raised_at,
      emergencyResolvedAt: preview.emergency_resolved_at,
    });
    if (early !== null) {
      return { ...early, raisedBy };
    }
    // Kabul etmeyen oturum da kilitsiz reddedilir; kilit altında yeniden kontrol edilir.
    this.assertAccepting(preview.status);

    // Kilit sırası booking → oturum; booking geçişleri (check-out) de aynı sırayı izler.
    // `FOR NO KEY UPDATE`: booking-state ile aynı kip (FK yazımlarını bloklamaz).
    await client.query(`SELECT id FROM bookings WHERE id = $1 FOR NO KEY UPDATE`, [
      preview.booking_id,
    ]);
    const session = await this.repository.lockParticipantSession(
      client,
      input.sessionId,
      input.userId,
      false,
    );
    if (session === null) {
      throw new BusinessException(ErrorCode.SAFETY_SESSION_NOT_FOUND);
    }

    // Kilit altında tekrar: ön okuma ile kilit arasında aynı kişinin eşzamanlı isteği
    // kaydedilmiş olabilir.
    const own = await this.findOwnActivePanic(client, session.id, input.userId, session);
    if (own !== null) {
      return { ...own, raisedBy };
    }

    this.assertAccepting(session.status);

    // Diğer tarafın etkin paniği varken basılan panik **yutulmaz**: ayrı bir kayıt
    // ve ayrı bir alarm olur. Aksi hâlde kötü niyetli tarafın önce bastığı sahte
    // panik, gerçek tehlikedeki kişinin paniğini görünmez kılardı (review bulgusu).
    const corroborating = isPanicActive(session);
    const marked = corroborating
      ? await this.repository.addPanicRaiser(client, session.id)
      : await this.repository.markPanic(
          client,
          session.id,
          this.config.env.SAFETY_EVIDENCE_RETENTION_DAYS,
        );
    if (marked === null) {
      throw new Error('panik oturuma işlenemedi');
    }

    // Askı her panikte istenir: "risk bitti" ile "hizmet devam edebilir" ayrı
    // kararlardır; operatör askıyı kaldırıp riski çözmemiş olabilir. Rezervasyon
    // zaten askıdaysa yeni geçiş olmaz ve `applied` false döner (review M2/L1).
    const hold = await this.applyBookingHold(client, session.bookingId);

    const event = await this.repository.insertEvent(client, {
      sessionId: session.id,
      bookingId: session.bookingId,
      eventType: 'PANIC_RAISED',
      source: 'USER',
      riskLevel: 'EMERGENCY',
      actorUserId: input.userId,
      details: {
        panicNumber: marked.panicNumber,
        raisedBy,
        category: input.category,
        corroborating,
        previousRiskLevel: session.riskLevel,
        sessionStatus: session.status,
        bookingHoldApplied: hold.applied,
        bookingOnHold: hold.onHold,
        ...(hold.errorCode !== null ? { bookingHoldError: hold.errorCode } : {}),
      },
    });

    await this.audit.record(client, {
      action: AuditAction.SAFETY_PANIC_RAISED,
      entityType: 'safety_session',
      entityId: session.id,
      actorUserId: input.userId,
      oldValue: { riskLevel: session.riskLevel },
      newValue: {
        riskLevel: 'EMERGENCY',
        bookingId: session.bookingId,
        eventId: event.id,
        corroborating,
        bookingHoldApplied: hold.applied,
      },
    });

    // Kalıcı alarm: Faz 9 tüketicileri (operatör konsolu, bildirim) bu event'i
    // at-least-once alır. Kişisel veri ve koordinat taşımaz.
    await this.outbox.enqueue(client, {
      eventType: EventType.SAFETY_ALERT_RAISED,
      subjectType: 'safety_session',
      subjectId: session.id,
      // Anahtarlar event kataloğundaki sözleşmedir (event-catalog.md).
      payload: {
        safetySessionId: session.id,
        bookingId: session.bookingId,
        severity: 'EMERGENCY',
        source: 'PANIC',
        eventId: event.id,
        raisedBy,
        category: input.category,
        corroborating,
      },
    });

    return {
      sessionId: session.id,
      bookingId: session.bookingId,
      eventId: event.id,
      raisedAt: corroborating ? event.occurredAt : marked.raisedAt,
      duplicate: false,
      bookingHoldApplied: hold.applied,
      raisedBy,
    };
  }

  /**
   * Panik yalnızca varış ve aktif hizmette kabul edilir.
   *
   * `PRE_SERVICE`: randevu planlandı ama sağlayıcı yola çıkmadı; taraflar fiziksel
   * olarak birlikte değildir ve burada panik kabul etmek günler önceden rezervasyonu
   * askıya alıp ödemeyi dondurmanın ucuz bir yolu olurdu. `CLOSED`: kapanmış oturum
   * acil durum kanalı değildir. İki durumda da istemci kullanıcıyı 112'ye yönlendirir.
   */
  private assertAccepting(status: string): void {
    if (status === 'CLOSED') {
      throw new BusinessException(ErrorCode.SAFETY_SESSION_ALREADY_CLOSED);
    }
    if (status !== 'ARRIVAL_MONITORING' && status !== 'ACTIVE') {
      throw new BusinessException(ErrorCode.SAFETY_SESSION_NOT_ACTIVE, {
        clientMessage: "Hizmet henüz başlamadı. Acil durumda 112'yi arayın.",
      });
    }
  }

  /**
   * Bu kişinin **etkin** panik bölümündeki kaydı (varsa).
   *
   * Tekrar basış aynı kişiye göre değerlendirilir: aynı kişi → yan etkisiz tekrar;
   * diğer taraf → yeni, doğrulayıcı kayıt.
   */
  private async findOwnActivePanic(
    client: PoolClient,
    sessionId: string,
    userId: string,
    state: { panicRaisedAt: Date | null; emergencyResolvedAt: Date | null },
  ): Promise<Omit<PanicResult, 'raisedBy'> | null> {
    if (state.panicRaisedAt === null || state.emergencyResolvedAt !== null) {
      return null;
    }
    const existing = await this.repository.findPanicByActor(
      client,
      sessionId,
      userId,
      state.panicRaisedAt,
    );
    if (existing === null) {
      return null;
    }
    return {
      sessionId,
      bookingId: existing.bookingId,
      eventId: existing.id,
      raisedAt: existing.occurredAt,
      duplicate: true,
      bookingHoldApplied: existing.bookingHoldApplied,
    };
  }

  /**
   * Rezervasyonu askıya alır — savepoint içinde.
   *
   * Askı, ödemenin serbest bırakılmasını bloklar (`SAFETY_HOLD` → ödeme donar).
   * Durum makinesi reddederse (ör. rezervasyon zaten uyuşmazlıkta) savepoint'e
   * dönülür ve panik kaydı etkilenmeden devam eder.
   */
  private async applyBookingHold(
    client: PoolClient,
    bookingId: string,
  ): Promise<{ applied: boolean; onHold: boolean; errorCode: string | null }> {
    const current = await client.query<{ status: string }>(
      `SELECT status FROM bookings WHERE id = $1`,
      [bookingId],
    );
    if (current.rows[0]?.status === 'SAFETY_HOLD') {
      return { applied: false, onHold: true, errorCode: null };
    }

    await client.query('SAVEPOINT panic_booking_hold');
    try {
      await this.bookings.advanceBySystemWithin(client, {
        bookingId,
        to: 'SAFETY_HOLD',
        reason: 'PANIC',
      });
      await client.query('RELEASE SAVEPOINT panic_booking_hold');
      return { applied: true, onHold: true, errorCode: null };
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT panic_booking_hold');
      const code = error instanceof BusinessException ? error.code : 'UNEXPECTED';
      this.logger.warn({ bookingId, code }, 'panik: rezervasyon askıya alınamadı');
      return { applied: false, onHold: false, errorCode: code };
    }
  }

  private notifyInBackground(
    result: PanicResult & { raisedBy: 'PROVIDER' | 'CUSTOMER' },
    category: PanicCategory | null,
  ): void {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('bildirim zaman aşımı'));
      }, NOTIFY_TIMEOUT_MS);
      timer.unref();
    });

    void Promise.race([
      this.notifier.notify({
        sessionId: result.sessionId,
        bookingId: result.bookingId,
        eventId: result.eventId,
        raisedBy: result.raisedBy,
        category,
        occurredAt: result.raisedAt,
      }),
      timeout,
    ])
      .catch((error: unknown) => {
        this.metrics.failure('safety.panic.notification_failed', {
          sessionId: result.sessionId,
          error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
        });
      })
      .finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
  }
}

function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE_SQLSTATES.has(code);
}
