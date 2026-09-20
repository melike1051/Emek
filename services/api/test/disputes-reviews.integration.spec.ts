import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { BookingsService } from '../src/bookings/bookings.service';
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
 * Uyuşmazlık ve değerlendirme akışları (ADR-0009 §9).
 *
 * İki kural test edilir: uyuşmazlığı **açmak** taraflara, **karara bağlamak** yalnızca
 * operatöre açıktır; değerlendirme yalnızca tamamlanmış bir hizmetin tarafından,
 * bir kez yazılabilir (Faz 7 matching skorunun girdisi olduğu için manipülasyona kapalı).
 */
describe('disputes & reviews (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;

  interface Fixture {
    customerToken: string;
    providerToken: string;
    adminToken: string;
    customerId: string;
    providerId: string;
    bookingId: string;
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

  async function setupBooking(seed: string): Promise<Fixture> {
    const customerId = await register(`dr-customer-${seed}`);
    const providerId = await register(`dr-provider-${seed}`);
    const adminId = await register(`dr-admin-${seed}`);
    const customerToken = bearer(`dr-customer-${seed}`);
    const providerToken = bearer(`dr-provider-${seed}`);
    const adminToken = bearer(`dr-admin-${seed}`);

    await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'ADMIN')`, [adminId]);

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

    return {
      customerToken,
      providerToken,
      adminToken,
      customerId,
      providerId,
      bookingId: booking.body.id as string,
    };
  }

  /** Rezervasyonu ödemeli gerçek akışla `COMPLETED` durumuna getirir. */
  async function completeBooking(fixture: Fixture): Promise<void> {
    const bookings = app.get(BookingsService);
    for (const to of ['MATCHED', 'PROVIDER_PENDING'] as const) {
      await bookings.advanceBySystem({ bookingId: fixture.bookingId, to });
    }

    await http()
      .post(`${PREFIX}/bookings/${fixture.bookingId}/confirm`)
      .set('authorization', fixture.providerToken)
      .expect(201);

    await http()
      .post(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
      .set('authorization', fixture.customerToken)
      .send({})
      .expect(201);

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

    await bookings.advanceBySystem({ bookingId: fixture.bookingId, to: 'COMPLETED' });
  }

  describe('uyuşmazlık açma', () => {
    it('taraf uyuşmazlık açar, rezervasyon ve ödeme dondurulur', async () => {
      const fixture = await setupBooking('open');
      await completeBooking(fixture);

      const response = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'SERVICE_QUALITY', description: 'temizlik eksik yapıldı' })
        .expect(201);

      expect(response.body.status).toBe('OPEN');

      const booking = await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}`)
        .set('authorization', fixture.customerToken)
        .expect(200);
      expect(booking.body.status).toBe('DISPUTED');

      const payment = await pool.query<{ status: string }>(
        `SELECT status FROM payments WHERE booking_id = $1`,
        [fixture.bookingId],
      );
      expect(payment.rows[0]?.status).toBe('DISPUTED');
    });

    it('sağlayıcı da uyuşmazlık açabilir', async () => {
      const fixture = await setupBooking('provider-open');
      await completeBooking(fixture);

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', fixture.providerToken)
        .send({ reason: 'BILLING' })
        .expect(201);
    });

    it('aynı rezervasyon için ikinci açık uyuşmazlık olamaz', async () => {
      const fixture = await setupBooking('duplicate');
      await completeBooking(fixture);

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'DAMAGE' })
        .expect(201);

      const second = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', fixture.providerToken)
        .send({ reason: 'BILLING' })
        .expect(409);

      expect(second.body.error.code).toBe('DISPUTE_ALREADY_OPEN');
    });

    it('hizmet başlamadan uyuşmazlık açılamaz', async () => {
      // Hizmet hiç başlamadıysa çözülecek uyuşmazlık değil, iptal vakası vardır.
      const fixture = await setupBooking('too-early');

      const response = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'SERVICE_NOT_PERFORMED' })
        .expect(409);

      expect(response.body.error.code).toBe('DISPUTE_WINDOW_CLOSED');
    });

    it('taraf olmayan kullanıcı uyuşmazlık açamaz ve listeleyemez', async () => {
      const fixture = await setupBooking('outsider');
      await completeBooking(fixture);
      await register('dr-outsider');

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'OTHER' })
        .expect(201);

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', bearer('dr-outsider'))
        .send({ reason: 'OTHER' })
        .expect(404);

      const listed = await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', bearer('dr-outsider'))
        .expect(200);
      expect(listed.body).toEqual([]);
    });
  });

  describe('uyuşmazlık kararı', () => {
    async function openDispute(fixture: Fixture): Promise<string> {
      const response = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'SERVICE_QUALITY' })
        .expect(201);
      return response.body.id as string;
    }

    it('taraflar kendi uyuşmazlığını karara bağlayamaz', async () => {
      const fixture = await setupBooking('self-resolve');
      await completeBooking(fixture);
      const disputeId = await openDispute(fixture);

      for (const token of [fixture.customerToken, fixture.providerToken]) {
        await http()
          .post(`${PREFIX}/disputes/${disputeId}/resolve`)
          .set('authorization', token)
          .send({ status: 'RESOLVED_CUSTOMER', resolution: 'kendi lehime' })
          .expect(403);
      }
    });

    it('operatör kararı rezervasyonu uyuşmazlıktan çıkarır', async () => {
      const fixture = await setupBooking('resolve');
      await completeBooking(fixture);
      const disputeId = await openDispute(fixture);

      const resolved = await http()
        .post(`${PREFIX}/disputes/${disputeId}/resolve`)
        .set('authorization', fixture.adminToken)
        .send({ status: 'RESOLVED_PROVIDER', resolution: 'hizmet kanıtlarla doğrulandı' })
        .expect(201);

      expect(resolved.body.status).toBe('RESOLVED_PROVIDER');
      expect(resolved.body.resolvedAt).not.toBeNull();

      const booking = await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}`)
        .set('authorization', fixture.customerToken)
        .expect(200);
      // Uyuşmazlıkta kalsaydı ödeme sonsuza kadar bloklu kalırdı.
      expect(booking.body.status).toBe('COMPLETED');
    });

    it('karara bağlanmış uyuşmazlık ikinci kez karara bağlanamaz', async () => {
      const fixture = await setupBooking('double-resolve');
      await completeBooking(fixture);
      const disputeId = await openDispute(fixture);

      await http()
        .post(`${PREFIX}/disputes/${disputeId}/resolve`)
        .set('authorization', fixture.adminToken)
        .send({ status: 'WITHDRAWN', resolution: 'taraflar anlaştı' })
        .expect(201);

      const second = await http()
        .post(`${PREFIX}/disputes/${disputeId}/resolve`)
        .set('authorization', fixture.adminToken)
        .send({ status: 'RESOLVED_CUSTOMER', resolution: 'ikinci karar' })
        .expect(409);

      expect(second.body.error.code).toBe('DISPUTE_NOT_OPEN');
    });

    it('karar audit.lenir ve kim karar verdiği kayıtlıdır', async () => {
      const fixture = await setupBooking('resolve-audit');
      await completeBooking(fixture);
      const disputeId = await openDispute(fixture);

      await http()
        .post(`${PREFIX}/disputes/${disputeId}/resolve`)
        .set('authorization', fixture.adminToken)
        .send({ status: 'RESOLVED_CUSTOMER', resolution: 'müşteri lehine' })
        .expect(201);

      const audit = await pool.query<{ actor_user_id: string | null }>(
        `SELECT actor_user_id FROM audit_logs
          WHERE action = 'DISPUTE_RESOLVED' AND entity_id = $1`,
        [disputeId],
      );
      expect(audit.rows[0]?.actor_user_id).not.toBeNull();

      const stored = await pool.query<{ resolved_by: string | null }>(
        `SELECT resolved_by FROM disputes WHERE id = $1`,
        [disputeId],
      );
      expect(stored.rows[0]?.resolved_by).not.toBeNull();
    });
  });

  describe('değerlendirme', () => {
    it('taraflar tamamlanmış hizmeti karşılıklı değerlendirir', async () => {
      const fixture = await setupBooking('review');
      await completeBooking(fixture);

      const byCustomer = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/review`)
        .set('authorization', fixture.customerToken)
        .send({ rating: 5, comment: 'çok memnun kaldım' })
        .expect(201);
      // Değerlendirilen karşı taraftır.
      expect(byCustomer.body.subjectUserId).toBe(fixture.providerId);

      const byProvider = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/review`)
        .set('authorization', fixture.providerToken)
        .send({ rating: 4 })
        .expect(201);
      expect(byProvider.body.subjectUserId).toBe(fixture.customerId);
    });

    it('aynı taraf ikinci kez değerlendiremez', async () => {
      const fixture = await setupBooking('double-review');
      await completeBooking(fixture);

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/review`)
        .set('authorization', fixture.customerToken)
        .send({ rating: 5 })
        .expect(201);

      const second = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/review`)
        .set('authorization', fixture.customerToken)
        .send({ rating: 1 })
        .expect(409);

      expect(second.body.error.code).toBe('REVIEW_ALREADY_EXISTS');
    });

    /**
     * Tamamlanmamış hizmet değerlendirilebilseydi, uydurma rezervasyonlarla matching
     * skoru (Faz 7) doğrudan manipüle edilebilirdi.
     */
    it('tamamlanmamış rezervasyon değerlendirilemez', async () => {
      const fixture = await setupBooking('incomplete-review');

      const response = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/review`)
        .set('authorization', fixture.customerToken)
        .send({ rating: 5 })
        .expect(409);

      expect(response.body.error.code).toBe('REVIEW_NOT_ALLOWED');
    });

    it('taraf olmayan kullanıcı değerlendirme yazamaz', async () => {
      const fixture = await setupBooking('outsider-review');
      await completeBooking(fixture);
      await register('dr-review-stranger');

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/review`)
        .set('authorization', bearer('dr-review-stranger'))
        .send({ rating: 1 })
        .expect(404);
    });

    it('geçersiz puan reddedilir', async () => {
      const fixture = await setupBooking('bad-rating');
      await completeBooking(fixture);

      for (const rating of [0, 6, 3.5]) {
        await http()
          .post(`${PREFIX}/bookings/${fixture.bookingId}/review`)
          .set('authorization', fixture.customerToken)
          .send({ rating })
          .expect(400);
      }
    });

    it('kullanıcı hakkındaki değerlendirmeler listelenir ama yazar gizlidir', async () => {
      const fixture = await setupBooking('list-reviews');
      await completeBooking(fixture);

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/review`)
        .set('authorization', fixture.customerToken)
        .send({ rating: 5, comment: 'harika' })
        .expect(201);

      const listed = await http()
        .get(`${PREFIX}/users/${fixture.providerId}/reviews`)
        .set('authorization', fixture.providerToken)
        .expect(200);

      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].rating).toBe(5);
      // Misilleme yüzeyini daraltmak için yazar dışarı verilmez.
      expect(listed.body[0].authorUserId).toBeUndefined();
    });
  });
});
