import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditAction, AuditService } from '../../common/audit/audit.service';
import { BusinessException } from '../../common/errors/business.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { SafetyLifecycleService } from '../../safety/safety-lifecycle.service';
import type { BookingStatus } from './booking-status';
import { findTransition, isActorAllowed, type TransitionActor } from './transitions';

export interface TransitionRequest {
  bookingId: string;
  to: BookingStatus;
  actor: TransitionActor;
  actorUserId?: string;
  reason?: string;
}

export interface TransitionResult {
  from: BookingStatus;
  to: BookingStatus;
  /** Booking zaten hedef durumdaysa true: idempotent tekrar çağrı. */
  alreadyInTargetState: boolean;
}

/**
 * Booking durum geçişlerinin **tek** yolu (ADR-0006 §3).
 *
 * `bookings.status` başka hiçbir yerden UPDATE edilmez. Bu sınıf:
 * - geçişin izin tablosunda olduğunu doğrular,
 * - aktörün yetkili olduğunu doğrular,
 * - satırı kilitler (`FOR NO KEY UPDATE`) ki eşzamanlı iki geçiş sıraya girsin,
 * - geçişi ve `booking_status_history` kaydını **aynı transaction'da** yazar,
 * - aynı hedefe tekrar çağrıldığında yan etki üretmez (idempotency).
 */
@Injectable()
export class BookingStateService {
  constructor(
    private readonly audit: AuditService,
    private readonly safety: SafetyLifecycleService,
  ) {}

  async transition(client: PoolClient, request: TransitionRequest): Promise<TransitionResult> {
    // Kilit: eşzamanlı iki geçiş aynı satırı okuyup ikisi de geçerli sanamaz.
    // `FOR NO KEY UPDATE`: geçişleri yine sıraya sokar ama çocuk tablolara (ör.
    // `safety_events.booking_id`) FK ile yazanların `KEY SHARE` kilidini bloklamaz.
    // `FOR UPDATE` bloklardı: oturum kilidini tutup olay yazan bir işlem (operatör
    // kapatması, telemetri) ile oturumu bekleyen check-out kilitlenirdi (Faz 8 review).
    const current = await client.query<{ status: BookingStatus }>(
      `SELECT status FROM bookings WHERE id = $1 FOR NO KEY UPDATE`,
      [request.bookingId],
    );

    const row = current.rows[0];
    if (row === undefined) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }

    const from = row.status;

    // Idempotency: retry, çift tıklama veya duplicate event ikinci yan etki üretmez.
    if (from === request.to) {
      return { from, to: request.to, alreadyInTargetState: true };
    }

    const rule = findTransition(from, request.to);
    if (rule === undefined) {
      throw new BusinessException(ErrorCode.INVALID_STATE_TRANSITION, {
        details: { from, to: request.to },
      });
    }

    if (!isActorAllowed(rule, request.actor)) {
      throw new BusinessException(ErrorCode.FORBIDDEN, {
        details: { from, to: request.to },
      });
    }

    // Cast'ler zorunlu: aynı parametre hem `booking_status` (SET) hem metin (CASE
    // karşılaştırması) olarak kullanılıyor; açık cast olmadan PostgreSQL
    // "inconsistent types deduced for parameter" hatası verir.
    await client.query(
      `UPDATE bookings
          SET status = $2::booking_status,
              cancelled_at = CASE WHEN $2::text = 'CANCELLED' THEN now() ELSE cancelled_at END,
              cancellation_reason =
                CASE WHEN $2::text = 'CANCELLED' THEN $3 ELSE cancellation_reason END
        WHERE id = $1`,
      [request.bookingId, request.to, request.reason ?? null],
    );

    await client.query(
      `INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [request.bookingId, from, request.to, request.actorUserId ?? null, request.reason ?? null],
    );

    // Güvenlik oturumu booking'i **aynı transaction'da** izler (ADR-0019 §2).
    // Burada olması "tek yol" ilkesinin sonucudur: ödeme, matching, operatör ve
    // taraflar durumu hep bu metottan ilerletir; oturumu ayrı bir çağrıya bırakmak,
    // bir yolun onu unutmasını mümkün kılardı (ör. check-out commit edilir ama
    // telemetri kapısı açık kalır). Yalnızca veritabanı yazar, dış çağrı yapmaz.
    //
    // **Audit kaydından önce** çalışır — kilit sırası kuralı: satır kilitleri
    // (booking → oturum) her zaman global audit zinciri kilidinden **önce** alınır.
    // Ters sırada (booking → audit → oturum) değerlendirici, operatör kapatması ya da
    // süre aşımı gibi "oturum → audit" yollarıyla deadlock oluşuyor ve check-in/out
    // 500 alıyordu (Faz 8 review H1).
    await this.safety.onBookingTransition(client, {
      bookingId: request.bookingId,
      to: request.to,
      ...(request.actorUserId !== undefined ? { actorUserId: request.actorUserId } : {}),
    });

    await this.audit.record(client, {
      action: AuditAction.BOOKING_STATUS_CHANGED,
      entityType: 'booking',
      entityId: request.bookingId,
      ...(request.actorUserId !== undefined ? { actorUserId: request.actorUserId } : {}),
      oldValue: { status: from },
      newValue: { status: request.to, actor: request.actor },
    });

    return { from, to: request.to, alreadyInTargetState: false };
  }
}
