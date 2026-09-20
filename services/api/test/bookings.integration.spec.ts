import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { BookingsService } from '../src/bookings/bookings.service';
import type { BookingStatus } from '../src/bookings/state/booking-status';
import {
  PREFIX,
  bearer,
  clearRateLimits,
  createPool,
  createRedis,
  createTestApp,
  ensureCatalog,
  resetDomainTables,
} from './helpers/test-app';

/**
 * Booking akışı (ADR-0006).
 *
 * Zorunlu senaryolar: T-05 (eşzamanlı çakışan rezervasyon), T-05b (iptal edilen slot
 * yeniden rezerve edilebilir), T-05c (kendi kendine rezervasyon), T-05e (Redis yokken
 * doğruluk), T-06 (geçersiz state geçişi), T-08 (müsait olmayan sağlayıcı).
 */
describe('bookings (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;

  /** Test verisi: müşteri, sağlayıcı, hizmet, adres ve müsaitlik penceresi. */
  interface Fixture {
    customerToken: string;
    providerToken: string;
    customerId: string;
    providerId: string;
    serviceId: string;
    addressId: string;
    slot: { start: string; end: string };
  }

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    redis = createRedis();
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    redis?.disconnect();
  });

  const http = (): request.Agent => request(app.getHttpServer());

  async function register(subject: string): Promise<string> {
    const response = await http()
      .post(`${PREFIX}/auth/session`)
      .set('authorization', bearer(subject))
      .expect(201);
    return response.body.userId as string;
  }

  /** Yarın için, müsaitlik penceresinin tamamen içinde kalan bir aralık üretir. */
  function tomorrowSlot(offsetHours = 0, durationHours = 2): { start: string; end: string } {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 1);
    start.setUTCHours(9 + offsetHours, 0, 0, 0);
    const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  async function setupFixture(seed: string): Promise<Fixture> {
    const customerId = await register(`bk-customer-${seed}`);
    const providerId = await register(`bk-provider-${seed}`);
    const customerToken = bearer(`bk-customer-${seed}`);
    const providerToken = bearer(`bk-provider-${seed}`);

    await http()
      .post(`${PREFIX}/customers/profile`)
      .set('authorization', customerToken)
      .send({ displayName: `Müşteri ${seed}` })
      .expect(201);

    await http()
      .post(`${PREFIX}/providers/profile`)
      .set('authorization', providerToken)
      .send({ displayName: `Sağlayıcı ${seed}` })
      .expect(201);

    const address = await http()
      .post(`${PREFIX}/addresses`)
      .set('authorization', customerToken)
      .send({
        city: 'İstanbul',
        district: 'Kadıköy',
        line: 'Test Mahallesi 1. Sokak No 2',
        latitude: 40.9909,
        longitude: 29.0303,
      })
      .expect(201);

    // Sağlayıcı sabah 8 - akşam 20 arası müsait: test aralıkları bunun içinde kalır.
    const windowStart = new Date();
    windowStart.setUTCDate(windowStart.getUTCDate() + 1);
    windowStart.setUTCHours(8, 0, 0, 0);
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCHours(20, 0, 0, 0);

    await http()
      .post(`${PREFIX}/providers/me/availability`)
      .set('authorization', providerToken)
      .send({ startsAt: windowStart.toISOString(), endsAt: windowEnd.toISOString() })
      .expect(201);

    const services = await http().get(`${PREFIX}/services`).expect(200);

    return {
      customerToken,
      providerToken,
      customerId,
      providerId,
      serviceId: services.body[0].id as string,
      addressId: address.body.id as string,
      slot: tomorrowSlot(),
    };
  }

  async function createBooking(
    fixture: Fixture,
    overrides: Partial<{ start: string; end: string; providerId: string }> = {},
  ): Promise<request.Response> {
    return http()
      .post(`${PREFIX}/bookings`)
      .set('authorization', fixture.customerToken)
      .send({
        providerId: overrides.providerId ?? fixture.providerId,
        serviceId: fixture.serviceId,
        addressId: fixture.addressId,
        scheduledStart: overrides.start ?? fixture.slot.start,
        scheduledEnd: overrides.end ?? fixture.slot.end,
        // Fiyat gönderilmez: sunucu katalogdan hesaplar (Faz 4 review bulgusu).
      });
  }

  describe('oluşturma', () => {
    it('rezervasyon REQUESTED durumunda oluşur ve geçmişe yazılır', async () => {
      const fixture = await setupFixture('create');

      const response = await createBooking(fixture);
      expect(response.status).toBe(201);
      expect(response.body.status).toBe('REQUESTED');
      // Para minor unit'te string olarak taşınır (BIGINT) ve sunucuda hesaplanır.
      expect(response.body.priceMinor).toMatch(/^\d+$/);
      expect(Number(response.body.priceMinor)).toBeGreaterThan(0);

      const history = await http()
        .get(`${PREFIX}/bookings/${response.body.id}/history`)
        .set('authorization', fixture.customerToken)
        .expect(200);

      expect(history.body).toEqual([
        expect.objectContaining({ fromStatus: null, toStatus: 'REQUESTED' }),
      ]);
    });

    // Faz 4 review bulgusu: fiyat istemciden alınırsa komisyon/GMV manipüle edilebilir.
    it('istemci fiyat gönderemez', async () => {
      const fixture = await setupFixture('price-injection');

      const response = await http()
        .post(`${PREFIX}/bookings`)
        .set('authorization', fixture.customerToken)
        .send({
          providerId: fixture.providerId,
          serviceId: fixture.serviceId,
          addressId: fixture.addressId,
          scheduledStart: fixture.slot.start,
          scheduledEnd: fixture.slot.end,
          priceMinor: 1,
        })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('saatlik hizmette fiyat süreye göre hesaplanır', async () => {
      const fixture = await setupFixture('hourly-price');

      // Katalogdaki saatlik ücreti oku ve iki saatlik rezervasyonla karşılaştır.
      const service = await pool.query<{ hourly_rate_minor: string | null }>(
        `SELECT hourly_rate_minor FROM services WHERE id = $1`,
        [fixture.serviceId],
      );
      const hourlyRate = service.rows[0]?.hourly_rate_minor;

      const response = await createBooking(fixture);
      expect(response.status).toBe(201);

      if (hourlyRate !== null && hourlyRate !== undefined) {
        // Varsayılan test aralığı iki saat.
        expect(response.body.priceMinor).toBe(String(BigInt(hourlyRate) * 2n));
      }
    });

    it('bitiş zamanı başlangıçtan önce olamaz', async () => {
      const fixture = await setupFixture('bad-range');

      const response = await createBooking(fixture, {
        start: fixture.slot.end,
        end: fixture.slot.start,
      });

      // DB CHECK'ine düşüp 500 üretmemeli.
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('BookingCreated event.i outbox.a yazılır', async () => {
      const fixture = await setupFixture('event');
      await createBooking(fixture);

      const events = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM outbox WHERE event_type = 'BookingCreated'`,
      );
      expect(events.rows[0]?.count).toBe('1');
    });

    // T-05c: tek User/iki profil modeli kendi kendine rezervasyona izin verirdi.
    it('kendi kendine rezervasyon reddedilir', async () => {
      const fixture = await setupFixture('self');

      // Müşteri aynı zamanda sağlayıcı profili açar ve kendini rezerve etmeye çalışır.
      await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', fixture.customerToken)
        .send({ displayName: 'Kendi Sağlayıcım' })
        .expect(201);

      const response = await createBooking(fixture, { providerId: fixture.customerId });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('SELF_BOOKING_NOT_ALLOWED');
    });

    it('başka kullanıcının adresiyle rezervasyon yapılamaz', async () => {
      const fixture = await setupFixture('foreign-address');
      const other = await setupFixture('other-owner');

      const response = await createBooking({ ...fixture, addressId: other.addressId });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('ADDRESS_NOT_FOUND');
    });

    // T-08: müsaitlik dışı talep hard constraint ile elenir.
    it('müsaitlik penceresi dışındaki aralık reddedilir', async () => {
      const fixture = await setupFixture('outside');
      // Pencere 08:00-20:00; 22:00 dışında kalır.
      const start = new Date(fixture.slot.start);
      start.setUTCHours(22, 0, 0, 0);
      const end = new Date(start.getTime() + 60 * 60 * 1000);

      const response = await createBooking(fixture, {
        start: start.toISOString(),
        end: end.toISOString(),
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PROVIDER_NOT_AVAILABLE');
    });

    it('müsaitlik istisnası olan aralık reddedilir', async () => {
      const fixture = await setupFixture('exception');

      await pool.query(
        `INSERT INTO availability_exceptions (provider_id, starts_at, ends_at, reason)
         VALUES ($1, $2, $3, 'izin')`,
        [fixture.providerId, fixture.slot.start, fixture.slot.end],
      );

      const response = await createBooking(fixture);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PROVIDER_NOT_AVAILABLE');
    });
  });

  // T-05: eşzamanlı çakışan rezervasyon; doğruluğun kaynağı EXCLUDE constraint'i.
  describe('çakışma engeli', () => {
    it('çakışan ikinci rezervasyon reddedilir', async () => {
      const fixture = await setupFixture('conflict');
      const first = await createBooking(fixture);
      expect(first.status).toBe(201);

      // Aynı aralığın ortasından başlayan, örtüşen bir talep.
      const overlapStart = new Date(new Date(fixture.slot.start).getTime() + 30 * 60 * 1000);
      const overlapEnd = new Date(overlapStart.getTime() + 60 * 60 * 1000);

      const second = await createBooking(fixture, {
        start: overlapStart.toISOString(),
        end: overlapEnd.toISOString(),
      });

      expect([409]).toContain(second.status);
      expect(['BOOKING_CONFLICT', 'PROVIDER_NOT_AVAILABLE']).toContain(second.body.error.code);

      const bookings = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM bookings WHERE provider_id = $1`,
        [fixture.providerId],
      );
      expect(bookings.rows[0]?.count).toBe('1');
    });

    it('eşzamanlı N istek tek rezervasyon üretir', async () => {
      const fixture = await setupFixture('race');

      const attempts = await Promise.all([
        createBooking(fixture),
        createBooking(fixture),
        createBooking(fixture),
        createBooking(fixture),
      ]);

      const created = attempts.filter((response) => response.status === 201);
      expect(created).toHaveLength(1);

      // Diğerleri kodlu çakışma hatası alır; 500 olmaz.
      for (const rejected of attempts.filter((response) => response.status !== 201)) {
        expect(rejected.status).toBe(409);
      }

      const bookings = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM bookings WHERE provider_id = $1`,
        [fixture.providerId],
      );
      expect(bookings.rows[0]?.count).toBe('1');
    });

    // T-05b: iptal edilen randevu slotu kalıcı bloklamamalı.
    it('iptal edilen slot yeniden rezerve edilebilir', async () => {
      const fixture = await setupFixture('cancel-reuse');
      const first = await createBooking(fixture);
      expect(first.status).toBe(201);

      await http()
        .post(`${PREFIX}/bookings/${first.body.id}/cancel`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'planlar değişti' })
        .expect(201);

      const second = await createBooking(fixture);
      expect(second.status).toBe(201);

      const statuses = await pool.query<{ status: string }>(
        `SELECT status FROM bookings WHERE provider_id = $1 ORDER BY created_at`,
        [fixture.providerId],
      );
      expect(statuses.rows.map((row) => row.status)).toEqual(['CANCELLED', 'REQUESTED']);
    });

    it('bitişik (örtüşmeyen) aralıklar kabul edilir', async () => {
      const fixture = await setupFixture('adjacent');
      const first = await createBooking(fixture);
      expect(first.status).toBe(201);

      // İlk rezervasyon bittiği anda başlayan ikinci aralık: '[)' sınırı sayesinde örtüşmez.
      const nextStart = new Date(fixture.slot.end);
      const nextEnd = new Date(nextStart.getTime() + 60 * 60 * 1000);

      const second = await createBooking(fixture, {
        start: nextStart.toISOString(),
        end: nextEnd.toISOString(),
      });

      expect(second.status).toBe(201);
    });

    /**
     * T-05e — Redis durumundan bağımsız doğruluk.
     *
     * Booking yolunda Redis **hiç kullanılmıyor**: çakışmanın tek kaynağı EXCLUDE
     * constraint'i. Bu test, Redis'in boşaltılmasının (cache/oran sınırı kaybı)
     * doğruluğu etkilemediğini gösterir — bir lock'ın yokluğunu değil.
     */
    it('Redis boşaltıldığında da çakışma engellenir', async () => {
      const fixture = await setupFixture('redis-down');
      await createBooking(fixture).then((response) => expect(response.status).toBe(201));

      await redis.flushdb();

      const second = await createBooking(fixture);
      expect(second.status).toBe(409);
    });
  });

  // T-06: geçersiz geçişler reddedilir, geçmişe yazılmaz.
  describe('durum geçişleri', () => {
    /**
     * Rezervasyonu hedef duruma **gerçek geçiş yolundan** getirir.
     *
     * Durumları doğrudan SQL ile yazmak, testin state machine'i atlayıp kendi kurduğu
     * bir duruma bakması olurdu: geçiş kuralları bozulsa bile testler geçerdi.
     * Bu yüzden sistem adımları `advanceBySystem` (matching/ödeme bu yolu kullanacak),
     * kullanıcı adımları HTTP üzerinden yürütülür.
     */
    async function bookingIn(fixture: Fixture, status: BookingStatus): Promise<string> {
      const created = await createBooking(fixture);
      const bookingId = created.body.id as string;
      const bookings = app.get(BookingsService);

      // REQUESTED → MATCHED → PROVIDER_PENDING: sistem (Faz 7 matching motoru).
      for (const to of ['MATCHED', 'PROVIDER_PENDING'] as const) {
        await bookings.advanceBySystem({ bookingId, to });
        if (to === status) {
          return bookingId;
        }
      }

      // Sağlayıcı onayı: gerçek endpoint.
      await http()
        .post(`${PREFIX}/bookings/${bookingId}/confirm`)
        .set('authorization', fixture.providerToken)
        .expect(201);
      if (status === 'CONFIRMED') {
        return bookingId;
      }

      // Ödeme adımları: sistem (Faz 5 ödeme akışı).
      for (const to of ['PAYMENT_AUTHORIZED', 'SCHEDULED'] as const) {
        await bookings.advanceBySystem({ bookingId, to });
        if (to === status) {
          return bookingId;
        }
      }

      return bookingId;
    }

    /** Rezervasyonu gerçek geçişlerle CHECKED_IN durumuna getirir. */
    async function checkedInBooking(fixture: Fixture): Promise<string> {
      const bookingId = await bookingIn(fixture, 'SCHEDULED');

      for (const to of ['PROVIDER_ARRIVING', 'CHECKED_IN'] as const) {
        await http()
          .post(`${PREFIX}/bookings/${bookingId}/transitions`)
          .set('authorization', fixture.providerToken)
          .send({ to })
          .expect(201);
      }

      return bookingId;
    }

    it('geçersiz geçiş reddedilir ve geçmişe yazılmaz', async () => {
      const fixture = await setupFixture('invalid-transition');
      const created = await createBooking(fixture);

      // REQUESTED durumundan doğrudan check-in denemesi.
      const response = await http()
        .post(`${PREFIX}/bookings/${created.body.id}/transitions`)
        .set('authorization', fixture.providerToken)
        .send({ to: 'CHECKED_IN' })
        .expect(409);

      expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');

      const history = await http()
        .get(`${PREFIX}/bookings/${created.body.id}/history`)
        .set('authorization', fixture.customerToken)
        .expect(200);
      expect(history.body).toHaveLength(1);
    });

    it('sağlayıcı onayı CONFIRMED yapar ve geçmişe yazılır', async () => {
      const fixture = await setupFixture('confirm');
      const bookingId = await bookingIn(fixture, 'PROVIDER_PENDING');

      const response = await http()
        .post(`${PREFIX}/bookings/${bookingId}/confirm`)
        .set('authorization', fixture.providerToken)
        .expect(201);

      expect(response.body.status).toBe('CONFIRMED');

      const history = await http()
        .get(`${PREFIX}/bookings/${bookingId}/history`)
        .set('authorization', fixture.providerToken)
        .expect(200);
      expect(history.body.at(-1)).toEqual(
        expect.objectContaining({ fromStatus: 'PROVIDER_PENDING', toStatus: 'CONFIRMED' }),
      );
    });

    it('müşteri sağlayıcının onayını veremez', async () => {
      const fixture = await setupFixture('wrong-actor');
      const bookingId = await bookingIn(fixture, 'PROVIDER_PENDING');

      const response = await http()
        .post(`${PREFIX}/bookings/${bookingId}/confirm`)
        .set('authorization', fixture.customerToken)
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('hizmet günü akışı sırayla ilerler', async () => {
      const fixture = await setupFixture('service-day');
      const bookingId = await bookingIn(fixture, 'SCHEDULED');

      for (const to of ['PROVIDER_ARRIVING', 'CHECKED_IN', 'IN_PROGRESS', 'CHECKED_OUT']) {
        const response = await http()
          .post(`${PREFIX}/bookings/${bookingId}/transitions`)
          .set('authorization', fixture.providerToken)
          .send({ to })
          .expect(201);
        expect(response.body.status).toBe(to);
      }

      // Son onay müşteriye aittir.
      const confirmed = await http()
        .post(`${PREFIX}/bookings/${bookingId}/transitions`)
        .set('authorization', fixture.customerToken)
        .send({ to: 'CUSTOMER_CONFIRMED' })
        .expect(201);
      expect(confirmed.body.status).toBe('CUSTOMER_CONFIRMED');

      const events = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM outbox WHERE event_type = 'ServiceStarted'`,
      );
      expect(events.rows).toHaveLength(1);
    });

    // T-07: aynı geçiş tekrar çağrıldığında yan etki üretmez.
    it('aynı geçiş tekrarı yan etki üretmez', async () => {
      const fixture = await setupFixture('idempotent-transition');
      const bookingId = await bookingIn(fixture, 'PROVIDER_PENDING');

      await http()
        .post(`${PREFIX}/bookings/${bookingId}/confirm`)
        .set('authorization', fixture.providerToken)
        .expect(201);
      await http()
        .post(`${PREFIX}/bookings/${bookingId}/confirm`)
        .set('authorization', fixture.providerToken)
        .expect(201);

      const transitions = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM booking_status_history
          WHERE booking_id = $1 AND to_status = 'CONFIRMED'`,
        [bookingId],
      );
      expect(transitions.rows[0]?.count).toBe('1');
    });

    /** Hizmet başladıktan sonra taraflar iptal edemez; para/emek harcanmıştır. */
    it('taraflar hizmet başladıktan sonra iptal edemez', async () => {
      const fixture = await setupFixture('no-cancel');
      const bookingId = await checkedInBooking(fixture);

      for (const token of [fixture.customerToken, fixture.providerToken]) {
        const response = await http()
          .post(`${PREFIX}/bookings/${bookingId}/cancel`)
          .set('authorization', token)
          .send({ reason: 'vazgeçtim' })
          .expect(403);

        expect(response.body.error.code).toBe('FORBIDDEN');
      }
    });

    /**
     * Güvenlik dışı bir aksaklıkta (ekipman arızası, müşteri evde değil) rezervasyon
     * sıkışmamalı: iptal operatör kararıdır, para akışı dispute/refund ile çözülür (Faz 5).
     */
    it('operatör hizmet sırasında iptal edebilir', async () => {
      const fixture = await setupFixture('admin-cancel');
      const bookingId = await checkedInBooking(fixture);

      const adminId = await register('bk-admin');
      // Rol atama endpoint'i Faz 10'da gelecek; test kurulumu doğrudan rol veriyor.
      await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'ADMIN')`, [adminId]);

      const response = await http()
        .post(`${PREFIX}/bookings/${bookingId}/cancel`)
        .set('authorization', bearer('bk-admin'))
        .send({ reason: 'ekipman arızası' })
        .expect(201);

      expect(response.body.status).toBe('CANCELLED');

      // Operatör aksiyonu audit'e yazılır (ADR-0013).
      const audits = await pool.query<{ actor_user_id: string }>(
        `SELECT actor_user_id FROM audit_logs
          WHERE action = 'BOOKING_STATUS_CHANGED' AND entity_id = $1
          ORDER BY id DESC LIMIT 1`,
        [bookingId],
      );
      expect(audits.rows[0]?.actor_user_id).toBe(adminId);
    });

    it('operatör olmayan üçüncü kişi hâlâ göremez', async () => {
      const fixture = await setupFixture('third-party');
      const bookingId = await checkedInBooking(fixture);
      await register('bk-random');

      await http()
        .post(`${PREFIX}/bookings/${bookingId}/cancel`)
        .set('authorization', bearer('bk-random'))
        .send({})
        .expect(404);
    });

    it('iptal gerekçesi ve zamanı kaydedilir', async () => {
      const fixture = await setupFixture('cancel-reason');
      const created = await createBooking(fixture);

      await http()
        .post(`${PREFIX}/bookings/${created.body.id}/cancel`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'sağlayıcı ulaşılamadı' })
        .expect(201);

      const row = await pool.query<{ cancelled_at: Date; cancellation_reason: string }>(
        `SELECT cancelled_at, cancellation_reason FROM bookings WHERE id = $1`,
        [created.body.id],
      );
      expect(row.rows[0]?.cancelled_at).not.toBeNull();
      expect(row.rows[0]?.cancellation_reason).toBe('sağlayıcı ulaşılamadı');
    });
  });

  describe('sahiplik', () => {
    it('taraf olmayan kullanıcı rezervasyonu göremez', async () => {
      const fixture = await setupFixture('privacy');
      const created = await createBooking(fixture);
      await register('bk-outsider');

      // Varlık bilgisi bile sızmaz: 403 değil 404.
      await http()
        .get(`${PREFIX}/bookings/${created.body.id}`)
        .set('authorization', bearer('bk-outsider'))
        .expect(404);
    });

    it('taraf olmayan kullanıcı geçiş tetikleyemez', async () => {
      const fixture = await setupFixture('outsider-transition');
      const created = await createBooking(fixture);
      await register('bk-outsider-2');

      await http()
        .post(`${PREFIX}/bookings/${created.body.id}/cancel`)
        .set('authorization', bearer('bk-outsider-2'))
        .send({})
        .expect(404);
    });

    it('her iki taraf da rezervasyonu görebilir', async () => {
      const fixture = await setupFixture('both-parties');
      const created = await createBooking(fixture);

      await http()
        .get(`${PREFIX}/bookings/${created.body.id}`)
        .set('authorization', fixture.customerToken)
        .expect(200);
      await http()
        .get(`${PREFIX}/bookings/${created.body.id}`)
        .set('authorization', fixture.providerToken)
        .expect(200);
    });
  });

  describe('veritabanı invariant.ları', () => {
    it('geçmiş append-only.dır', async () => {
      const fixture = await setupFixture('history-immutable');
      const created = await createBooking(fixture);

      await expect(
        pool.query(
          `UPDATE booking_status_history SET to_status = 'COMPLETED' WHERE booking_id = $1`,
          [created.body.id],
        ),
      ).rejects.toThrow(/append-only/);

      await expect(
        pool.query(`DELETE FROM booking_status_history WHERE booking_id = $1`, [created.body.id]),
      ).rejects.toThrow(/append-only/);
    });

    it('REQUESTED dışındaki durum sağlayıcı olmadan yazılamaz', async () => {
      const fixture = await setupFixture('provider-required');
      const created = await createBooking(fixture);

      await expect(
        pool.query(`UPDATE bookings SET provider_id = NULL, status = 'CONFIRMED' WHERE id = $1`, [
          created.body.id,
        ]),
      ).rejects.toThrow(/bookings_provider_required/);
    });

    it('negatif fiyat reddedilir', async () => {
      const fixture = await setupFixture('negative-price');

      await expect(
        pool.query(
          `INSERT INTO bookings (customer_id, provider_id, service_id, address_id,
             scheduled_start, scheduled_end, price_minor)
           VALUES ($1, $2, $3, $4, $5, $6, -100)`,
          [
            fixture.customerId,
            fixture.providerId,
            fixture.serviceId,
            fixture.addressId,
            fixture.slot.start,
            fixture.slot.end,
          ],
        ),
      ).rejects.toThrow(/price_minor/);
    });

    it('PostGIS konum lat/lon.dan türetilir ve indeks kullanılır', async () => {
      const fixture = await setupFixture('postgis');

      const location = await pool.query<{ lat: number; lon: number }>(
        `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon
           FROM addresses WHERE id = $1`,
        [fixture.addressId],
      );
      expect(location.rows[0]?.lat).toBeCloseTo(40.9909, 4);
      expect(location.rows[0]?.lon).toBeCloseTo(29.0303, 4);

      // Coğrafi sorgu GIST indeksini kullanabilmeli: uygulama katmanında mesafe
      // hesaplamak 10.000 sağlayıcıda kabul edilemez (ADR-0003).
      //
      // Planlayıcı maliyete göre karar verir; tek satırlı tabloda seq scan her zaman
      // daha ucuzdur. Bu yüzden transaction içinde gerçekçi bir veri hacmi üretilir
      // (sonunda geri alınır) ve seq scan caydırılır. `SET LOCAL` transaction gerektirir.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO addresses (user_id, city, district, line, latitude, longitude)
           SELECT $1, 'İstanbul', 'Test', 'Sokak ' || g,
                  40.5 + (g % 100) * 0.01, 28.5 + (g % 100) * 0.01
             FROM generate_series(1, 2000) g`,
          [fixture.customerId],
        );
        await client.query('ANALYZE addresses');
        await client.query('SET LOCAL enable_seqscan = off');

        const plan = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT id FROM addresses
            WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(29.03, 40.99), 4326)::geography, 5000)`,
        );

        expect(plan.rows.map((row) => row['QUERY PLAN']).join(' ')).toContain(
          'idx_addresses_location',
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('müsaitlik yönetimi', () => {
    it('çakışan müsaitlik penceresi reddedilir', async () => {
      const fixture = await setupFixture('availability-overlap');
      const start = new Date(fixture.slot.start);
      const end = new Date(fixture.slot.end);

      const response = await http()
        .post(`${PREFIX}/providers/me/availability`)
        .set('authorization', fixture.providerToken)
        .send({ startsAt: start.toISOString(), endsAt: end.toISOString() })
        .expect(409);

      expect(response.body.error.code).toBe('BOOKING_CONFLICT');
    });

    it('başka sağlayıcının müsaitliği silinemez', async () => {
      const fixture = await setupFixture('availability-owner');
      const other = await setupFixture('availability-other');

      const windows = await http()
        .get(`${PREFIX}/providers/me/availability`)
        .set('authorization', other.providerToken)
        .query({
          from: new Date(Date.now() - 86400000).toISOString(),
          to: new Date(Date.now() + 7 * 86400000).toISOString(),
        })
        .expect(200);

      await http()
        .delete(`${PREFIX}/providers/me/availability/${windows.body[0].id}`)
        .set('authorization', fixture.providerToken)
        .expect(404);
    });
  });
});
