import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { UnitOfWork } from '../common/database/unit-of-work';
import type { PaymentStatus } from './state/payment-status';

export interface Payment {
  id: string;
  bookingId: string;
  provider: string;
  externalPaymentId: string | null;
  amountMinor: string;
  currency: string;
  refundedMinor: string;
  status: PaymentStatus;
  authorizedAt: Date | null;
  authorizationExpiresAt: Date | null;
  reauthorizationCount: number;
  releasedAt: Date | null;
  failureCode: string | null;
  /** Dondurulmadan önceki durum; çözümde buraya dönülür (ADR-0017 §7). */
  frozenFromStatus: PaymentStatus | null;
}

interface PaymentRow {
  id: string;
  booking_id: string;
  provider: string;
  external_payment_id: string | null;
  amount_minor: string;
  currency: string;
  refunded_minor: string;
  status: PaymentStatus;
  authorized_at: Date | null;
  authorization_expires_at: Date | null;
  reauthorization_count: number;
  released_at: Date | null;
  failure_code: string | null;
  frozen_from_status: PaymentStatus | null;
}

const SELECT_PAYMENT = `
  SELECT id, booking_id, provider, external_payment_id, amount_minor, currency,
         refunded_minor, status, authorized_at, authorization_expires_at,
         reauthorization_count, released_at, failure_code, frozen_from_status
    FROM payments
`;

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    bookingId: row.booking_id,
    provider: row.provider,
    externalPaymentId: row.external_payment_id,
    // BIGINT string olarak taşınır: JavaScript number parayı güvenle temsil etmez.
    amountMinor: row.amount_minor,
    currency: row.currency,
    refundedMinor: row.refunded_minor,
    status: row.status,
    authorizedAt: row.authorized_at,
    authorizationExpiresAt: row.authorization_expires_at,
    reauthorizationCount: Number(row.reauthorization_count),
    releasedAt: row.released_at,
    failureCode: row.failure_code,
    frozenFromStatus: row.frozen_from_status,
  };
}

export interface PaymentEventRecord {
  id: string;
  eventType: string;
  fromStatus: PaymentStatus | null;
  toStatus: PaymentStatus | null;
  applied: boolean;
  receivedAt: Date;
}

/** `payment_commands` rezervasyon sonucu: anahtar yeni mi, yoksa zaten var mı? */
export type CommandReservation =
  | { outcome: 'RESERVED'; commandId: string }
  | { outcome: 'ALREADY_SENT'; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' };

@Injectable()
export class PaymentsRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async create(
    client: PoolClient,
    input: { bookingId: string; provider: string; amountMinor: string; currency: string },
  ): Promise<Payment> {
    const result = await client.query<PaymentRow>(
      `INSERT INTO payments (booking_id, provider, amount_minor, currency)
       VALUES ($1, $2, $3, $4)
       RETURNING id, booking_id, provider, external_payment_id, amount_minor, currency,
                 refunded_minor, status, authorized_at, authorization_expires_at,
                 reauthorization_count, released_at, failure_code, frozen_from_status`,
      [input.bookingId, input.provider, input.amountMinor, input.currency],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('ödeme kaydı oluşturulamadı');
    }
    return toPayment(row);
  }

  /** Satırı kilitleyerek okur: eşzamanlı iki geçiş sıraya girer. */
  async findByIdLocked(client: PoolClient, paymentId: string): Promise<Payment | null> {
    const result = await client.query<PaymentRow>(`${SELECT_PAYMENT} WHERE id = $1 FOR UPDATE`, [
      paymentId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toPayment(row);
  }

  async findByExternalIdLocked(
    client: PoolClient,
    provider: string,
    externalPaymentId: string,
  ): Promise<Payment | null> {
    const result = await client.query<PaymentRow>(
      `${SELECT_PAYMENT} WHERE provider = $1 AND external_payment_id = $2 FOR UPDATE`,
      [provider, externalPaymentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPayment(row);
  }

  /** Rezervasyonun canlı ödemesi (başarısız/süresi dolmuş/iade edilmiş olanlar hariç). */
  async findLiveForBooking(bookingId: string, client?: PoolClient): Promise<Payment | null> {
    const sql = `${SELECT_PAYMENT}
      WHERE booking_id = $1
        AND status NOT IN ('FAILED', 'AUTHORIZATION_EXPIRED', 'REFUNDED')`;

    const rows =
      client === undefined
        ? await this.uow.query<PaymentRow>(sql, [bookingId])
        : (await client.query<PaymentRow>(sql, [bookingId])).rows;

    const row = rows[0];
    return row === undefined ? null : toPayment(row);
  }

  /**
   * Admin izleme listesi (Faz 10). Sahiplik kapısı yoktur — bkz.
   * `BookingsRepository.listForAdmin` gerekçesi.
   */
  async listForAdmin(filter: {
    status?: PaymentStatus;
    bookingId?: string;
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<Array<Payment & { createdAt: Date }>> {
    const rows = await this.uow.query<PaymentRow & { created_at: Date }>(
      `SELECT id, booking_id, provider, external_payment_id, amount_minor, currency,
              refunded_minor, status, authorized_at, authorization_expires_at,
              reauthorization_count, released_at, failure_code, frozen_from_status, created_at
         FROM payments
        WHERE ($1::payment_status IS NULL OR status = $1)
          AND ($2::uuid IS NULL OR booking_id = $2)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4))
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [
        filter.status ?? null,
        filter.bookingId ?? null,
        filter.before?.createdAt ?? null,
        filter.before?.id ?? null,
        filter.limit,
      ],
    );
    return rows.map((row) => ({ ...toPayment(row), createdAt: row.created_at }));
  }

  /** Sahiplik sorgunun içindedir: taraf olmayan kullanıcı ödemeyi göremez (404). */
  async findForBookingAsParticipant(bookingId: string, userId: string): Promise<Payment | null> {
    const rows = await this.uow.query<PaymentRow>(
      `SELECT p.id, p.booking_id, p.provider, p.external_payment_id, p.amount_minor, p.currency,
              p.refunded_minor, p.status, p.authorized_at, p.authorization_expires_at,
              p.reauthorization_count, p.released_at, p.failure_code, p.frozen_from_status
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
        WHERE p.booking_id = $1 AND (b.customer_id = $2 OR b.provider_id = $2)
        ORDER BY p.created_at DESC
        LIMIT 1`,
      [bookingId, userId],
    );
    const row = rows[0];
    return row === undefined ? null : toPayment(row);
  }

  async updateStatus(
    client: PoolClient,
    input: {
      paymentId: string;
      status: PaymentStatus;
      externalPaymentId?: string;
      authorizedAt?: Date;
      authorizationExpiresAt?: Date;
      refundedMinor?: string;
      failureCode?: string;
      incrementReauthorization?: boolean;
      /** `DISPUTED`'a geçerken doldurulur, çözümde temizlenir. */
      frozenFromStatus?: PaymentStatus | null;
    },
  ): Promise<void> {
    await client.query(
      `UPDATE payments
          SET status = $2::payment_status,
              external_payment_id = coalesce($3, external_payment_id),
              authorized_at = coalesce($4, authorized_at),
              authorization_expires_at = coalesce($5, authorization_expires_at),
              refunded_minor = coalesce($6::bigint, refunded_minor),
              failure_code = CASE
                WHEN $7::text IS NOT NULL THEN $7
                -- Başarısızlık dışı bir duruma geçişte eski hata kodu taşınmaz;
                -- CHECK zaten bunu reddeder.
                WHEN $2::text IN ('FAILED', 'AUTHORIZATION_EXPIRED') THEN failure_code
                ELSE NULL
              END,
              reauthorization_count = reauthorization_count + CASE WHEN $8 THEN 1 ELSE 0 END,
              -- Dondurma kaynağı yalnızca DISPUTED durumunda taşınır; CHECK bunu zorlar.
              frozen_from_status = CASE
                WHEN $2::text = 'DISPUTED' THEN coalesce($9::payment_status, frozen_from_status)
                ELSE NULL
              END,
              released_at = CASE WHEN $2::text = 'RELEASED' THEN coalesce(released_at, now()) END
        WHERE id = $1`,
      [
        input.paymentId,
        input.status,
        input.externalPaymentId ?? null,
        input.authorizedAt ?? null,
        input.authorizationExpiresAt ?? null,
        input.refundedMinor ?? null,
        input.failureCode ?? null,
        input.incrementReauthorization ?? false,
        input.frozenFromStatus ?? null,
      ],
    );
  }

  /**
   * Gelen webhook olayını kaydeder.
   *
   * `null` dönerse olay **zaten işlenmiştir** (UNIQUE ihlali): çağıran hiçbir yan etki
   * üretmeden başarı döner (ADR-0009 §7, T-09).
   */
  async insertEvent(
    client: PoolClient,
    input: {
      provider: string;
      externalEventId: string;
      eventType: string;
      paymentId?: string;
      providerSequence?: number;
      occurredAt?: Date;
      summary?: Record<string, unknown>;
    },
  ): Promise<string | null> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO payment_events
         (provider, external_event_id, event_type, payment_id, provider_sequence,
          occurred_at, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider, external_event_id) DO NOTHING
       RETURNING id::text`,
      [
        input.provider,
        input.externalEventId,
        input.eventType,
        input.paymentId ?? null,
        input.providerSequence ?? null,
        input.occurredAt ?? null,
        JSON.stringify(input.summary ?? {}),
      ],
    );

    return result.rows[0]?.id ?? null;
  }

  async markEventApplied(
    client: PoolClient,
    input: {
      eventId: string;
      paymentId: string;
      fromStatus: PaymentStatus;
      toStatus: PaymentStatus;
    },
  ): Promise<void> {
    await client.query(
      `UPDATE payment_events
          SET applied = TRUE, payment_id = $2,
              from_status = $3::payment_status, to_status = $4::payment_status
        WHERE id = $1::bigint`,
      [input.eventId, input.paymentId, input.fromStatus, input.toStatus],
    );
  }

  /** Uygulanmayan olay da kaydı kalır; neden uygulanmadığı `summary`'de değil durum alanlarındadır. */
  async attachEventPayment(client: PoolClient, eventId: string, paymentId: string): Promise<void> {
    await client.query(`UPDATE payment_events SET payment_id = $2 WHERE id = $1::bigint`, [
      eventId,
      paymentId,
    ]);
  }

  async listEvents(paymentId: string): Promise<PaymentEventRecord[]> {
    const rows = await this.uow.query<{
      id: string;
      event_type: string;
      from_status: PaymentStatus | null;
      to_status: PaymentStatus | null;
      applied: boolean;
      received_at: Date;
    }>(
      `SELECT id::text, event_type, from_status, to_status, applied, received_at
         FROM payment_events WHERE payment_id = $1 ORDER BY id`,
      [paymentId],
    );

    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      applied: row.applied,
      receivedAt: row.received_at,
    }));
  }

  /**
   * Giden çağrı için idempotency anahtarını **çağrıdan önce** rezerve eder (ADR-0009 §5).
   *
   * `ALREADY_SENT` dönerse çağrı daha önce gönderilmiştir ve tekrar gönderilmez:
   * at-least-once teslimli bir event'ten gelen tekrar burada durur (T-38).
   */
  async reserveCommand(
    client: PoolClient,
    input: { paymentId: string; operation: string; attempt: number; idempotencyKey: string },
  ): Promise<CommandReservation> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO payment_commands (payment_id, operation, attempt, idempotency_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id::text`,
      [input.paymentId, input.operation, input.attempt, input.idempotencyKey],
    );

    const row = inserted.rows[0];
    if (row !== undefined) {
      return { outcome: 'RESERVED', commandId: row.id };
    }

    const existing = await client.query<{ status: 'PENDING' | 'SUCCEEDED' | 'FAILED' }>(
      `SELECT status FROM payment_commands WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    return { outcome: 'ALREADY_SENT', status: existing.rows[0]?.status ?? 'PENDING' };
  }

  async completeCommand(
    client: PoolClient,
    input: { commandId: string; status: 'SUCCEEDED' | 'FAILED'; resultCode?: string },
  ): Promise<void> {
    await client.query(
      `UPDATE payment_commands
          SET status = $2::payment_command_status, result_code = $3, completed_at = now()
        WHERE id = $1::bigint`,
      [input.commandId, input.status, input.resultCode ?? null],
    );
  }

  /**
   * Yeniden kullanılabilir komut: gönderildi ama sonucu **bilinmiyor** (PENDING) ve
   * üstünden kiralama süresi geçmiş.
   *
   * Kritik: belirsiz bir hatadan (timeout/erişilemez) sonra yeni bir idempotency
   * anahtarıyla tekrar denemek, sağlayıcı ilk çağrıyı **işlemiş** olabileceği için
   * ikinci kez para hareketi üretir. Bu yüzden retry aynı satırı ve aynı anahtarı
   * kullanır; sağlayıcı mükerrer çağrıyı kendi tarafında eler (ADR-0017 §4).
   *
   * Kiralama süresi dolmamış bir `PENDING` satır **hâlâ uçuşta** demektir: eşzamanlı
   * ikinci bir istek onu yeniden kullanamaz, `PAYMENT_COMMAND_IN_FLIGHT` alır.
   */
  async findReusableCommand(
    client: PoolClient,
    input: { paymentId: string; operation: string; leaseSeconds: number },
  ): Promise<{ commandId: string; idempotencyKey: string; inFlight: boolean } | null> {
    const result = await client.query<{
      id: string;
      idempotency_key: string;
      in_flight: boolean;
    }>(
      `SELECT id::text, idempotency_key,
              (created_at > now() - ($3 || ' seconds')::interval) AS in_flight
         FROM payment_commands
        WHERE payment_id = $1 AND operation = $2 AND status = 'PENDING'
        ORDER BY attempt DESC
        LIMIT 1
        FOR UPDATE`,
      [input.paymentId, input.operation, String(input.leaseSeconds)],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return { commandId: row.id, idempotencyKey: row.idempotency_key, inFlight: row.in_flight };
  }

  async countCommands(paymentId: string, operation: string): Promise<number> {
    const rows = await this.uow.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payment_commands
        WHERE payment_id = $1 AND operation = $2`,
      [paymentId, operation],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Yetkilendirme süresi yaklaşan ödemeler (re-authorization işi için).
   *
   * `FOR UPDATE SKIP LOCKED` yok: bu sorgu yalnızca aday listesi üretir, her aday
   * kendi transaction'ında kilitlenerek işlenir.
   */
  async findExpiringAuthorizations(thresholdHours: number, limit: number): Promise<Payment[]> {
    const rows = await this.uow.query<PaymentRow>(
      `${SELECT_PAYMENT}
        WHERE status IN ('AUTHORIZED', 'HELD', 'SERVICE_COMPLETED')
          AND authorization_expires_at IS NOT NULL
          AND authorization_expires_at <= now() + ($1 || ' hours')::interval
        ORDER BY authorization_expires_at
        LIMIT $2`,
      [String(thresholdHours), limit],
    );
    return rows.map(toPayment);
  }
}
