import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AddressesService } from '../addresses/addresses.service';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { EventType, OutboxService } from '../common/outbox/outbox.service';
import { CatalogService } from '../catalog/catalog.service';
import { PaymentsService } from '../payments/payments.service';
import { AvailabilityService } from '../providers/availability.service';
import type { AppRole } from '../users/user.types';
import { BookingStateService } from './state/booking-state.service';
import type { BookingStatus } from './state/booking-status';
import type { TransitionActor } from './state/transitions';

export interface Booking {
  id: string;
  requestId: string | null;
  customerId: string;
  providerId: string | null;
  serviceId: string;
  addressId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  priceMinor: string;
  currency: string;
  status: BookingStatus;
}

interface BookingRow {
  id: string;
  request_id: string | null;
  customer_id: string;
  provider_id: string | null;
  service_id: string;
  address_id: string;
  scheduled_start: Date;
  scheduled_end: Date;
  price_minor: string;
  currency: string;
  status: BookingStatus;
}

export interface CreateBookingInput {
  /**
   * Rezervasyonun kaynaklandığı talep (Faz 7).
   *
   * Eşleştirmeyle oluşan rezervasyon talebe bağlanır: bağ olmadan "bu rezervasyon
   * hangi kararla, hangi algoritma sürümüyle oluştu" sorusu yanıtsız kalır ve
   * Ar-Ge izlenebilirliği (ADR-0012) kopar. Müşterinin doğrudan oluşturduğu
   * rezervasyonda talep yoktur.
   */
  requestId?: string;
  customerId: string;
  providerId: string;
  serviceId: string;
  addressId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

export interface BookingHistoryEntry {
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  reason: string | null;
  createdAt: Date;
}

/** PostgreSQL exclusion_violation — EXCLUDE constraint ihlali. */
const EXCLUSION_VIOLATION = '23P01';
/** PostgreSQL check_violation. */
const CHECK_VIOLATION = '23514';

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function pgConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    requestId: row.request_id,
    customerId: row.customer_id,
    providerId: row.provider_id,
    serviceId: row.service_id,
    addressId: row.address_id,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    // BIGINT string olarak taşınır: JavaScript number'ı parayı güvenli temsil etmez.
    priceMinor: row.price_minor,
    currency: row.currency,
    status: row.status,
  };
}

const SELECT_BOOKING = `
  SELECT id, request_id, customer_id, provider_id, service_id, address_id,
         scheduled_start, scheduled_end, price_minor, currency, status
    FROM bookings
`;

@Injectable()
export class BookingsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly state: BookingStateService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly addresses: AddressesService,
    private readonly availability: AvailabilityService,
    private readonly catalog: CatalogService,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * Rezervasyon oluşturur (kendi transaction'ında).
   *
   * Faz 4'te sağlayıcı doğrudan verilir (müşteri seçer). Faz 7'de matching motoru
   * `REQUESTED` durumundaki talebi alıp sağlayıcıyı atar; bu yüzden `provider_id`
   * nullable ve durum bazlı zorunlu (R-14 kararı).
   */
  async create(input: CreateBookingInput): Promise<Booking> {
    return this.uow.withTransaction((client) => this.createWithin(client, input));
  }

  /**
   * Rezervasyonu **verilen** transaction içinde oluşturur.
   *
   * Eşleştirme motoru (Faz 7) talebi kilitler, adayları okur, karar kaydını yazar ve
   * rezervasyonu **aynı** transaction'da oluşturur: ayrı transaction açmak hem ikinci
   * bir bağlantı tutup kilit sırasını bozar hem de "karar yazıldı ama rezervasyon
   * oluşmadı" durumunu mümkün kılardı.
   */
  async createWithin(client: PoolClient, input: CreateBookingInput): Promise<Booking> {
    if (input.scheduledEnd.getTime() <= input.scheduledStart.getTime()) {
      throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Bitiş zamanı başlangıçtan sonra olmalı.',
        details: { fields: ['scheduledEnd'] },
      });
    }

    if (input.customerId === input.providerId) {
      throw new BusinessException(ErrorCode.SELF_BOOKING_NOT_ALLOWED);
    }

    const address = await this.addresses.findOwned(input.customerId, input.addressId);
    if (address === null) {
      throw new BusinessException(ErrorCode.ADDRESS_NOT_FOUND);
    }

    // Fiyat sunucuda hesaplanır; istemci tutar gönderemez.
    const durationMinutes = (input.scheduledEnd.getTime() - input.scheduledStart.getTime()) / 60000;
    const { priceMinor } = await this.catalog.priceFor(input.serviceId, durationMinutes);

    {
      // Müsaitlik kontrolü **transaction içinde** ve pencereyi kilitleyerek yapılır:
      // dışarıda yapılsaydı sağlayıcı aradan pencereyi silebilir ve rezervasyon
      // beyan edilmiş saatlerin dışına düşebilirdi (TOCTOU). Kilit, kaydı commit'e
      // kadar silinmekten korur; çakışmayı ise EXCLUDE constraint'i garanti eder.
      const available = await this.availability.isAvailableLocked(client, input.providerId, {
        startsAt: input.scheduledStart,
        endsAt: input.scheduledEnd,
      });
      if (!available) {
        throw new BusinessException(ErrorCode.PROVIDER_NOT_AVAILABLE);
      }

      let inserted;
      try {
        inserted = await client.query<BookingRow>(
          `INSERT INTO bookings
             (request_id, customer_id, provider_id, service_id, address_id,
              scheduled_start, scheduled_end, price_minor, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'REQUESTED')
           RETURNING id, request_id, customer_id, provider_id, service_id, address_id,
                     scheduled_start, scheduled_end, price_minor, currency, status`,
          [
            input.requestId ?? null,
            input.customerId,
            input.providerId,
            input.serviceId,
            input.addressId,
            input.scheduledStart,
            input.scheduledEnd,
            priceMinor,
          ],
        );
      } catch (error) {
        throw this.translateWriteError(error);
      }

      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('rezervasyon oluşturulamadı');
      }

      // İlk durum da geçmişe yazılır: "nereden başladı" bilgisi olmadan zincir eksik kalır.
      await client.query(
        `INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by)
         VALUES ($1, NULL, 'REQUESTED', $2)`,
        [row.id, input.customerId],
      );

      await this.audit.record(client, {
        action: AuditAction.BOOKING_CREATED,
        entityType: 'booking',
        entityId: row.id,
        actorUserId: input.customerId,
        newValue: {
          providerId: row.provider_id,
          serviceId: row.service_id,
          scheduledStart: row.scheduled_start.toISOString(),
        },
      });

      await this.outbox.enqueue(client, {
        eventType: EventType.BOOKING_CREATED,
        subjectType: 'booking',
        subjectId: row.id,
        // Adres ve kişisel veri event'te taşınmaz; tüketici yetkisiyle okur.
        payload: {
          bookingId: row.id,
          customerId: row.customer_id,
          providerId: row.provider_id,
          serviceId: row.service_id,
          scheduledStart: row.scheduled_start.toISOString(),
          scheduledEnd: row.scheduled_end.toISOString(),
        },
      });

      return toBooking(row);
    }
  }

  /**
   * Rezervasyonu yalnızca tarafına gösterir.
   *
   * Sorgu hem müşteri hem sağlayıcı kimliğiyle kapsanır: üçüncü bir kullanıcı id'yi
   * bilse bile erişemez ve varlık bilgisi sızmaz (404 döner).
   */
  async findForParticipant(bookingId: string, userId: string): Promise<Booking | null> {
    const rows = await this.uow.query<BookingRow>(
      `${SELECT_BOOKING} WHERE id = $1 AND (customer_id = $2 OR provider_id = $2)`,
      [bookingId, userId],
    );
    const row = rows[0];
    return row === undefined ? null : toBooking(row);
  }

  async listForUser(userId: string): Promise<Booking[]> {
    const rows = await this.uow.query<BookingRow>(
      `${SELECT_BOOKING} WHERE customer_id = $1 OR provider_id = $1
        ORDER BY scheduled_start DESC LIMIT 100`,
      [userId],
    );
    return rows.map(toBooking);
  }

  async history(bookingId: string, userId: string): Promise<BookingHistoryEntry[]> {
    // Geçmiş de sahiplikle kapsanır.
    const rows = await this.uow.query<{
      from_status: BookingStatus | null;
      to_status: BookingStatus;
      reason: string | null;
      created_at: Date;
    }>(
      `SELECT h.from_status, h.to_status, h.reason, h.created_at
         FROM booking_status_history h
         JOIN bookings b ON b.id = h.booking_id
        WHERE h.booking_id = $1 AND (b.customer_id = $2 OR b.provider_id = $2)
        ORDER BY h.id`,
      [bookingId, userId],
    );

    return rows.map((row) => ({
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  /**
   * Durum geçişi. Yetki iki katmanlıdır: rol (transition map) **ve** rezervasyonun
   * tarafı olmak (burada). Rol tek başına yetki değildir (ADR-0013 §1).
   */
  async transition(input: {
    bookingId: string;
    to: BookingStatus;
    userId: string;
    roles: AppRole[];
    reason?: string;
  }): Promise<Booking> {
    return this.uow.withTransaction(async (client) => {
      const booking = await this.loadParticipantBooking(
        client,
        input.bookingId,
        input.userId,
        input.roles,
      );
      const actor = this.resolveActor(booking, input.userId, input.roles);

      await this.assertPaymentAllows(client, input.bookingId, input.to);

      await this.state.transition(client, {
        bookingId: input.bookingId,
        to: input.to,
        actor,
        actorUserId: input.userId,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });

      await this.applyPaymentEffects(client, input.bookingId, input.to);
      await this.publishLifecycleEvent(client, input.bookingId, input.to);

      const updated = await client.query<BookingRow>(`${SELECT_BOOKING} WHERE id = $1`, [
        input.bookingId,
      ]);
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error('güncellenen rezervasyon okunamadı');
      }
      return toBooking(row);
    });
  }

  /**
   * Sistem aktörlü geçiş (`SYSTEM`).
   *
   * Eşleştirme motoru (Faz 7), ödeme webhook'u (Faz 5) ve safety motoru (Faz 8) durumu
   * kullanıcı isteği olmadan ilerletir. Bu geçişler de **aynı** state machine'den geçer:
   * ayrı bir "içeriden güncelleme" yolu açmak, transition map'i atlatılabilir kılardı.
   */
  async advanceBySystem(input: {
    bookingId: string;
    to: BookingStatus;
    reason?: string;
  }): Promise<Booking> {
    return this.uow.withTransaction((client) => this.advanceBySystemWithin(client, input));
  }

  /**
   * Sistem aktörlü geçişi **verilen** transaction içinde uygular.
   *
   * Panik akışı (Faz 8) güvenlik olayını, oturum durumunu ve rezervasyon askısını
   * tek transaction'da yazar: ayrı transaction'lar "panik kaydedildi ama rezervasyon
   * askıya alınmadı (ödeme serbest bırakılabilir)" durumunu mümkün kılardı.
   * Geçiş yine aynı state machine'den ve aynı ödeme etkilerinden geçer.
   */
  async advanceBySystemWithin(
    client: PoolClient,
    input: { bookingId: string; to: BookingStatus; reason?: string },
  ): Promise<Booking> {
    await this.assertPaymentAllows(client, input.bookingId, input.to);

    await this.state.transition(client, {
      bookingId: input.bookingId,
      to: input.to,
      actor: 'SYSTEM',
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    await this.applyPaymentEffects(client, input.bookingId, input.to);
    await this.publishLifecycleEvent(client, input.bookingId, input.to);

    const updated = await client.query<BookingRow>(`${SELECT_BOOKING} WHERE id = $1`, [
      input.bookingId,
    ]);
    const row = updated.rows[0];
    if (row === undefined) {
      throw new Error('güncellenen rezervasyon okunamadı');
    }
    return toBooking(row);
  }

  /**
   * Geçiş için rezervasyonu yükler.
   *
   * Taraflar (müşteri/sağlayıcı) sahiplikle kapsanır. `ADMIN` **taraf olmadan** da
   * yükleyebilir: operatörün müdahale etmesi gereken geçişler (güvenlik askısından
   * çıkarma, uyuşmazlık kararı) tanımı gereği üçüncü taraf aksiyonudur. Sahiplik
   * kapısı admin'i de eleseydi bu geçişler hiç tetiklenemezdi (Faz 4 review bulgusu).
   * Her admin aksiyonu audit'e yazılır (ADR-0013).
   */
  private async loadParticipantBooking(
    client: PoolClient,
    bookingId: string,
    userId: string,
    roles: AppRole[],
  ): Promise<BookingRow> {
    const isAdmin = roles.includes('ADMIN');
    const rows = await client.query<BookingRow>(
      `${SELECT_BOOKING}
        WHERE id = $1 AND ($3::boolean OR customer_id = $2 OR provider_id = $2)`,
      [bookingId, userId, isAdmin],
    );

    const row = rows.rows[0];
    if (row === undefined) {
      // Taraf olmayan (ve admin olmayan) kullanıcıya varlık bilgisi verilmez.
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }
    return row;
  }

  /**
   * Kullanıcının bu rezervasyondaki rolü.
   *
   * Aynı kişi hem müşteri hem sağlayıcı olabilir (ADR-0004), bu yüzden aktör global
   * rollerden değil **bu rezervasyondaki konumdan** türetilir. `ADMIN` operasyonel
   * aksiyonlar için ayrıca kabul edilir.
   */
  private resolveActor(booking: BookingRow, userId: string, roles: AppRole[]): TransitionActor {
    if (booking.customer_id === userId) {
      return 'CUSTOMER';
    }
    if (booking.provider_id === userId) {
      return 'PROVIDER';
    }
    if (roles.includes('ADMIN')) {
      return 'ADMIN';
    }
    throw new BusinessException(ErrorCode.FORBIDDEN);
  }

  /**
   * Geçişten **önce** çalışan ödeme kapısı.
   *
   * `SETTLED`, "sağlayıcıya ödendi" demektir. Para serbest bırakılmadan bu duruma
   * geçilebilseydi, hiç para çıkmamışken mutabakatlanmış görünen rezervasyonlar
   * üretilebilirdi (ADR-0009 §3: booking aggregate root, ödeme projeksiyondur —
   * ama projeksiyon yalanlanamaz).
   */
  private async assertPaymentAllows(
    client: PoolClient,
    bookingId: string,
    to: BookingStatus,
  ): Promise<void> {
    if (to === 'SETTLED') {
      await this.payments.assertSettlementAllowed(client, bookingId);
    }
  }

  /**
   * Geçişten **sonra** çalışan ödeme etkileri.
   *
   * Ödeme durumu burada yalnızca **ilerletilir**; para hareketi başlatılmaz.
   * Hizmet tamamlandı diye otomatik release yapılsaydı uyuşmazlık penceresi
   * hiç olmazdı (ADR-0009 §6).
   */
  private async applyPaymentEffects(
    client: PoolClient,
    bookingId: string,
    to: BookingStatus,
  ): Promise<void> {
    if (to === 'COMPLETED') {
      await this.payments.markServiceCompleted(client, bookingId);
      return;
    }

    if (to === 'DISPUTED' || to === 'SAFETY_HOLD') {
      // Güvenlik askısı da parayı dondurur: askı sırasında release edilebilseydi
      // güvenlik incelemesi anlamsızlaşırdı.
      await this.payments.freezeForDispute(client, bookingId);
      return;
    }

    // Askıdan normal akışa dönüş (yanlış alarm): para çözülür. Çözülmeseydi bir güvenlik
    // yanlış alarmı, hizmeti gerçekten tamamlamış sağlayıcının parasını kalıcı olarak
    // dondururdu (Faz 5 review bulgusu C2).
    if (to === 'IN_PROGRESS') {
      await this.payments.unfreeze(client, bookingId);
    }
  }

  private async publishLifecycleEvent(
    client: PoolClient,
    bookingId: string,
    status: BookingStatus,
  ): Promise<void> {
    const eventType = {
      CONFIRMED: EventType.BOOKING_CONFIRMED,
      CANCELLED: EventType.BOOKING_CANCELLED,
      IN_PROGRESS: EventType.SERVICE_STARTED,
      COMPLETED: EventType.SERVICE_COMPLETED,
    }[status as string];

    if (eventType === undefined) {
      return;
    }

    await this.outbox.enqueue(client, {
      eventType,
      subjectType: 'booking',
      subjectId: bookingId,
      payload: { bookingId, status },
    });
  }

  /** Veritabanı invariant ihlallerini kodlu iş hatasına çevirir. */
  private translateWriteError(error: unknown): unknown {
    const code = pgErrorCode(error);
    const constraint = pgConstraint(error);

    if (code === EXCLUSION_VIOLATION) {
      // EXCLUDE constraint: aynı sağlayıcı için çakışan aktif rezervasyon.
      return new BusinessException(ErrorCode.BOOKING_CONFLICT);
    }

    if (code === CHECK_VIOLATION) {
      if (constraint === 'bookings_not_self') {
        return new BusinessException(ErrorCode.SELF_BOOKING_NOT_ALLOWED);
      }
      // Diğer invariant ihlalleri de kullanıcı hatasıdır: ham Postgres hatası
      // 500'e dönüşmemeli (Faz 4 review bulgusu).
      return new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Rezervasyon bilgileri geçersiz.',
        ...(constraint !== undefined ? { details: { constraint } } : {}),
      });
    }

    return error;
  }
}
