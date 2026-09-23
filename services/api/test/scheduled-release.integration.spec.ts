import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { BookingsService } from '../src/bookings/bookings.service';
import { MockPaymentProvider } from '../src/payments/mock-payment-provider';
import { ScheduledReleaseWorker } from '../src/payments/scheduled-release.worker';
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
 * Zamanlanmış ödeme release entegrasyon testleri (R-42).
 *
 * Worker'ın mevcut release guard'larını kullandığını ve ilgili koşulları doğru
 * değerlendirdiğini doğrular. Fikstür `payments.integration.spec.ts`'teki gibi
 * **gerçek geçiş yolundan** kurulur (SQL ile durum yazmak state machine'i atlar);
 * yalnızca zamana bağlı koşul (uyuşmazlık penceresi) SQL ile geriye alınır.
 */
describe('scheduled payment release (R-42)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let worker: ScheduledReleaseWorker;

  interface Fixture {
    customerToken: string;
    providerToken: string;
    bookingId: string;
  }

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    redis = createRedis();
    worker = app.get(ScheduledReleaseWorker);
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);
    app.get(MockPaymentProvider).setUnavailable(false);
    app.get(MockPaymentProvider).setDeclineNext(false);
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

  /** Rezervasyonu gerçek geçiş yolundan `CONFIRMED` durumuna getirir. */
  async function setupConfirmedBooking(seed: string): Promise<Fixture> {
    await register(`sr-customer-${seed}`);
    const providerId = await register(`sr-provider-${seed}`);
    const customerToken = bearer(`sr-customer-${seed}`);
    const providerToken = bearer(`sr-provider-${seed}`);

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

    const start = new Date(windowStart);
    start.setUTCHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    const booking = await http()
      .post(`${PREFIX}/bookings`)
      .set('authorization', customerToken)
      .send({
        providerId,
        serviceId: services.body[0].id,
        addressId: address.body.id,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
      })
      .expect(201);

    const bookings = app.get(BookingsService);
    for (const to of ['MATCHED', 'PROVIDER_PENDING'] as const) {
      await bookings.advanceBySystem({ bookingId: booking.body.id as string, to });
    }

    await http()
      .post(`${PREFIX}/bookings/${booking.body.id}/confirm`)
      .set('authorization', providerToken)
      .expect(201);

    return { customerToken, providerToken, bookingId: booking.body.id as string };
  }

  async function authorize(fixture: Fixture): Promise<string> {
    const response = await http()
      .post(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
      .set('authorization', fixture.customerToken)
      .send({})
      .expect(201);
    return response.body.paymentId as string;
  }

  /** Hizmet gününü gerçek geçişlerle tamamlar: booking `COMPLETED`, ödeme `SERVICE_COMPLETED` olur. */
  async function completeService(fixture: Fixture): Promise<void> {
    for (const to of ['PROVIDER_ARRIVING', 'CHECKED_IN', 'IN_PROGRESS', 'CHECKED_OUT'] as const) {
      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/transitions`)
        .set('authorization', fixture.providerToken)
        .send({ to })
        .expect(201);
    }

    await http()
      .post(`${PREFIX}/bookings/${fixture.bookingId}/transitions`)
      .set('authorization', fixture.customerToken)
      .send({ to: 'CUSTOMER_CONFIRMED' })
      .expect(201);

    await app.get(BookingsService).advanceBySystem({
      bookingId: fixture.bookingId,
      to: 'COMPLETED',
    });
  }

  /**
   * "Uyuşmazlık penceresi geçti" koşulunu zamanı bekleyip geçirmek yerine SQL ile
   * geriye alır. `bookings_set_updated_at` trigger'ı her UPDATE'te `updated_at`'i
   * `now()`'a zorladığı için önce geçici olarak devre dışı bırakılır (DDL — tabloya
   * özgü, session'a özgü değil; test suite `maxWorkers: 1` ile sıralı çalıştığı için
   * güvenlidir). Durum makinesi atlanmaz: booking gerçek akışla `COMPLETED` olmuştur,
   * yalnızca zaman damgası geriye alınır.
   */
  async function backdateBookingCompletion(bookingId: string, hoursAgo: number): Promise<void> {
    await pool.query(`ALTER TABLE bookings DISABLE TRIGGER bookings_set_updated_at`);
    try {
      await pool.query(
        `UPDATE bookings SET updated_at = now() - ($2 || ' hours')::interval WHERE id = $1`,
        [bookingId, String(hoursAgo)],
      );
    } finally {
      await pool.query(`ALTER TABLE bookings ENABLE TRIGGER bookings_set_updated_at`);
    }
  }

  async function expireAuthorization(paymentId: string): Promise<void> {
    await pool.query(
      `UPDATE payments SET authorization_expires_at = now() - interval '1 hour' WHERE id = $1`,
      [paymentId],
    );
  }

  async function paymentStatus(paymentId: string): Promise<string> {
    const rows = await pool.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [
      paymentId,
    ]);
    return rows.rows[0]!.status;
  }

  it('uyuşmazlık penceresi geçmiş, uygun ödeme serbest bırakılır', async () => {
    const fixture = await setupConfirmedBooking('release');
    const paymentId = await authorize(fixture);
    await completeService(fixture);
    expect(await paymentStatus(paymentId)).toBe('SERVICE_COMPLETED');

    await backdateBookingCompletion(fixture.bookingId, 72); // 48 saatlik dispute window'u geçmiş

    const released = await worker.tick();

    expect(released).toBe(1);
    expect(await paymentStatus(paymentId)).toBe('RELEASED');
  });

  it('uyuşmazlık penceresi geçmemiş ödeme aday olarak seçilmez', async () => {
    const fixture = await setupConfirmedBooking('early');
    const paymentId = await authorize(fixture);
    await completeService(fixture);

    // updated_at gerçek akıştan az önce ayarlandı — 48 saatlik pencere henüz geçmedi.
    const released = await worker.tick();

    expect(released).toBe(0);
    expect(await paymentStatus(paymentId)).toBe('SERVICE_COMPLETED');
  });

  it('yetkilendirmesi dolmuş ödeme aday olarak seçilmez', async () => {
    const fixture = await setupConfirmedBooking('expired');
    const paymentId = await authorize(fixture);
    await completeService(fixture);
    await backdateBookingCompletion(fixture.bookingId, 72);
    await expireAuthorization(paymentId);

    const released = await worker.tick();

    expect(released).toBe(0);
    expect(await paymentStatus(paymentId)).toBe('SERVICE_COMPLETED');
  });

  it('ödeme SERVICE_COMPLETED olmadan (hizmet tamamlanmadan) aday olarak seçilmez', async () => {
    const fixture = await setupConfirmedBooking('incomplete');
    const paymentId = await authorize(fixture);
    // completeService() çağrılmadı: booking CONFIRMED'da, ödeme AUTHORIZED/HELD'de kalır.

    const released = await worker.tick();

    expect(released).toBe(0);
    expect(await paymentStatus(paymentId)).not.toBe('SERVICE_COMPLETED');
  });

  it('aday yoksa worker 0 döner', async () => {
    const released = await worker.tick();
    expect(released).toBe(0);
  });

  it('ikinci tick aynı ödemeyi tekrar seçmez (idempotent)', async () => {
    const fixture = await setupConfirmedBooking('idem');
    const paymentId = await authorize(fixture);
    await completeService(fixture);
    await backdateBookingCompletion(fixture.bookingId, 72);

    const first = await worker.tick();
    expect(first).toBe(1);
    expect(await paymentStatus(paymentId)).toBe('RELEASED');

    const second = await worker.tick();
    expect(second).toBe(0);
  });
});
