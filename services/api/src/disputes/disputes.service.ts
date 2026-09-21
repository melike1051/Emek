import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { EventType, OutboxService } from '../common/outbox/outbox.service';
import { BookingStateService } from '../bookings/state/booking-state.service';
import type { BookingStatus } from '../bookings/state/booking-status';
import { PaymentsService } from '../payments/payments.service';

export const DISPUTE_REASONS = [
  'SERVICE_NOT_PERFORMED',
  'SERVICE_QUALITY',
  'DAMAGE',
  'BILLING',
  'SAFETY',
  'OTHER',
] as const;

export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export type DisputeStatus =
  'OPEN' | 'UNDER_REVIEW' | 'RESOLVED_CUSTOMER' | 'RESOLVED_PROVIDER' | 'WITHDRAWN';

export interface Dispute {
  id: string;
  bookingId: string;
  openedBy: string | null;
  reason: DisputeReason;
  description: string | null;
  status: DisputeStatus;
  resolution: string | null;
  refundAmountMinor: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

interface DisputeRow {
  id: string;
  booking_id: string;
  opened_by: string | null;
  reason: DisputeReason;
  description: string | null;
  status: DisputeStatus;
  resolution: string | null;
  refund_amount_minor: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function toDispute(row: DisputeRow): Dispute {
  return {
    id: row.id,
    bookingId: row.booking_id,
    openedBy: row.opened_by,
    reason: row.reason,
    description: row.description,
    status: row.status,
    resolution: row.resolution,
    refundAmountMinor: row.refund_amount_minor,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

const SELECT_DISPUTE = `
  SELECT id, booking_id, opened_by, reason, description, status, resolution,
         refund_amount_minor, created_at, resolved_at
    FROM disputes
`;

/** Uyuşmazlığın açılabildiği booking durumları: hizmet en azından başlamış olmalı. */
const DISPUTABLE_STATUSES: readonly BookingStatus[] = [
  'CHECKED_IN',
  'IN_PROGRESS',
  'CHECKED_OUT',
  'CUSTOMER_CONFIRMED',
  'COMPLETED',
  'SAFETY_HOLD',
  'DISPUTED',
];

/**
 * Uyuşmazlık akışı (ADR-0009 §9).
 *
 * Uyuşmazlık **açmak** taraflara açıktır; **karara bağlamak** yalnızca operatöre.
 * Taraflardan biri kendi lehine karar verebilse, uyuşmazlık mekanizması anlamsız olurdu.
 *
 * Uyuşmazlık açıldığı anda ödeme dondurulur: para serbest bırakıldıktan sonra geri
 * almak çok daha zordur, bu yüzden blok kararı gecikmemelidir.
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly payments: PaymentsService,
    private readonly bookingState: BookingStateService,
  ) {}

  async open(input: {
    bookingId: string;
    userId: string;
    reason: DisputeReason;
    description?: string;
  }): Promise<Dispute> {
    return this.uow.withTransaction(async (client) => {
      const booking = await client.query<{
        status: BookingStatus;
        customer_id: string;
        provider_id: string | null;
      }>(
        `SELECT status, customer_id, provider_id FROM bookings
          WHERE id = $1 AND (customer_id = $2 OR provider_id = $2)
          FOR UPDATE`,
        [input.bookingId, input.userId],
      );

      const row = booking.rows[0];
      if (row === undefined) {
        // Taraf olmayan kullanıcı rezervasyonun varlığını öğrenemez.
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }

      if (!DISPUTABLE_STATUSES.includes(row.status)) {
        // Hizmet hiç başlamadıysa çözülecek bir uyuşmazlık değil, iptal vakası vardır.
        throw new BusinessException(ErrorCode.DISPUTE_WINDOW_CLOSED, {
          details: { bookingStatus: row.status },
        });
      }

      let inserted;
      try {
        inserted = await client.query<DisputeRow>(
          `INSERT INTO disputes (booking_id, opened_by, reason, description)
           VALUES ($1, $2, $3::dispute_reason, $4)
           RETURNING id, booking_id, opened_by, reason, description, status, resolution,
                     refund_amount_minor, created_at, resolved_at`,
          [input.bookingId, input.userId, input.reason, input.description ?? null],
        );
      } catch (error) {
        // Kısmi unique index: aynı rezervasyon için ikinci açık uyuşmazlık olamaz.
        if ((error as { code?: string }).code === '23505') {
          throw new BusinessException(ErrorCode.DISPUTE_ALREADY_OPEN);
        }
        throw error;
      }

      const dispute = inserted.rows[0];
      if (dispute === undefined) {
        throw new Error('uyuşmazlık kaydı oluşturulamadı');
      }

      // Ödeme dondurulur: uyuşmazlık açıkken para serbest bırakılmaz (T-11).
      await this.payments.freezeForDispute(client, input.bookingId);

      // Booking de `DISPUTED` olur — ancak yalnızca geçiş tanımlıysa: `SAFETY_HOLD`
      // durumundan çıkış operatör kararıdır, uyuşmazlık açmak onu geçersiz kılmaz.
      if (row.status !== 'DISPUTED' && row.status !== 'SAFETY_HOLD') {
        await this.bookingState.transition(client, {
          bookingId: input.bookingId,
          to: 'DISPUTED',
          actor: this.actorFor(row, input.userId),
          actorUserId: input.userId,
          reason: input.reason,
        });
      }

      await this.audit.record(client, {
        action: AuditAction.DISPUTE_OPENED,
        entityType: 'dispute',
        entityId: dispute.id,
        actorUserId: input.userId,
        newValue: { bookingId: input.bookingId, reason: input.reason },
      });

      await this.outbox.enqueue(client, {
        eventType: EventType.DISPUTE_OPENED,
        subjectType: 'dispute',
        subjectId: dispute.id,
        payload: { disputeId: dispute.id, bookingId: input.bookingId, reason: input.reason },
      });

      return toDispute(dispute);
    });
  }

  /**
   * Uyuşmazlığı karara bağlar (**operatör aksiyonu**).
   *
   * İade kararı burada verilir ama para hareketi ayrı ve açık bir `refund` çağrısıdır:
   * karar kaydı ile para hareketini tek transaction'da birleştirmek, sağlayıcı çağrısını
   * veritabanı transaction'ının içine sokmak olurdu (ADR-0009 §6).
   */
  async resolve(input: {
    disputeId: string;
    actorUserId: string;
    status: 'RESOLVED_CUSTOMER' | 'RESOLVED_PROVIDER' | 'WITHDRAWN';
    resolution: string;
    refundAmountMinor?: string;
  }): Promise<Dispute> {
    return this.uow.withTransaction(async (client) => {
      const existing = await client.query<DisputeRow>(
        `${SELECT_DISPUTE} WHERE id = $1 FOR UPDATE`,
        [input.disputeId],
      );

      const row = existing.rows[0];
      if (row === undefined) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }
      if (row.status !== 'OPEN' && row.status !== 'UNDER_REVIEW') {
        throw new BusinessException(ErrorCode.DISPUTE_NOT_OPEN);
      }

      const updated = await client.query<DisputeRow>(
        `UPDATE disputes
            SET status = $2::dispute_status, resolution = $3, resolved_by = $4,
                resolved_at = now(), refund_amount_minor = $5::bigint
          WHERE id = $1
          RETURNING id, booking_id, opened_by, reason, description, status, resolution,
                    refund_amount_minor, created_at, resolved_at`,
        [
          row.id,
          input.status,
          input.resolution,
          input.actorUserId,
          input.refundAmountMinor ?? null,
        ],
      );

      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) {
        throw new Error('uyuşmazlık güncellenemedi');
      }

      // Ödeme de uyuşmazlıktan çıkar ve dondurulduğu duruma döner. Aksi halde sağlayıcı
      // lehine karar verilmiş bir uyuşmazlıkta bile para ne serbest bırakılabilir ne
      // iade edilebilirdi (Faz 5 review bulgusu C2). Müşteri lehine kararda da ödeme
      // çözülür: iade `refund` ile, release ise guard'lardan geçerek yapılır.
      await this.payments.unfreeze(client, row.booking_id);

      // Rezervasyon uyuşmazlıktan çıkar: operatör kararı hangi yöne olursa olsun
      // rezervasyonun `DISPUTED` durumunda kalması, ödemeyi sonsuza kadar bloklardı.
      const booking = await client.query<{ status: BookingStatus }>(
        `SELECT status FROM bookings WHERE id = $1 FOR NO KEY UPDATE`,
        [row.booking_id],
      );
      if (booking.rows[0]?.status === 'DISPUTED') {
        await this.bookingState.transition(client, {
          bookingId: row.booking_id,
          to: input.status === 'RESOLVED_CUSTOMER' ? 'CANCELLED' : 'COMPLETED',
          actor: 'ADMIN',
          actorUserId: input.actorUserId,
          reason: input.status,
        });
      }

      await this.audit.record(client, {
        action: AuditAction.DISPUTE_RESOLVED,
        entityType: 'dispute',
        entityId: row.id,
        actorUserId: input.actorUserId,
        oldValue: { status: row.status },
        newValue: {
          status: input.status,
          refundAmountMinor: input.refundAmountMinor ?? null,
        },
      });

      await this.outbox.enqueue(client, {
        eventType: EventType.DISPUTE_RESOLVED,
        subjectType: 'dispute',
        subjectId: row.id,
        payload: {
          disputeId: row.id,
          bookingId: row.booking_id,
          status: input.status,
        },
      });

      return toDispute(updatedRow);
    });
  }

  /** Taraflar kendi uyuşmazlıklarını görür; operatör hepsini. */
  async listForBooking(bookingId: string, userId: string, roles: string[]): Promise<Dispute[]> {
    const isAdmin = roles.includes('ADMIN');
    const rows = await this.uow.query<DisputeRow>(
      `SELECT d.id, d.booking_id, d.opened_by, d.reason, d.description, d.status,
              d.resolution, d.refund_amount_minor, d.created_at, d.resolved_at
         FROM disputes d
         JOIN bookings b ON b.id = d.booking_id
        WHERE d.booking_id = $1
          AND ($3::boolean OR b.customer_id = $2 OR b.provider_id = $2)
        ORDER BY d.created_at DESC`,
      [bookingId, userId, isAdmin],
    );
    return rows.map(toDispute);
  }

  hasOpenDispute(client: PoolClient, bookingId: string): Promise<boolean> {
    return client
      .query<{ id: string }>(
        `SELECT id FROM disputes WHERE booking_id = $1 AND status IN ('OPEN','UNDER_REVIEW') LIMIT 1`,
        [bookingId],
      )
      .then((result) => result.rowCount !== null && result.rowCount > 0);
  }

  private actorFor(
    booking: { customer_id: string; provider_id: string | null },
    userId: string,
  ): 'CUSTOMER' | 'PROVIDER' {
    return booking.customer_id === userId ? 'CUSTOMER' : 'PROVIDER';
  }
}
