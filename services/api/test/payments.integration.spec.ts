import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { BookingsService } from '../src/bookings/bookings.service';
import { MockPaymentProvider } from '../src/payments/mock-payment-provider';
import { PaymentsService } from '../src/payments/payments.service';
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
 * Ödeme akışı (ADR-0009).
 *
 * Zorunlu senaryolar: T-09 (duplicate webhook), T-10 (out-of-order event),
 * T-11 (dispute/SAFETY_HOLD varken release bloğu), T-34 (yetkilendirme süresi dolmuş
 * release + re-authorization), T-38 (event'ten para hareketi tetiklenmemesi).
 */
describe('payments (integration)', () => {
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
    // Sağlayıcı test kancaları testler arasında sızmamalı.
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

  /**
   * Rezervasyonu **gerçek geçiş yolundan** `CONFIRMED` durumuna getirir.
   *
   * Durumları SQL ile yazmak testin state machine'i atlaması olurdu: kurallar bozulsa
   * bile testler geçerdi.
   */
  async function setupConfirmedBooking(seed: string): Promise<Fixture> {
    const customerId = await register(`pay-customer-${seed}`);
    const providerId = await register(`pay-provider-${seed}`);
    const adminId = await register(`pay-admin-${seed}`);
    const customerToken = bearer(`pay-customer-${seed}`);
    const providerToken = bearer(`pay-provider-${seed}`);
    const adminToken = bearer(`pay-admin-${seed}`);

    // Rol atama endpoint'i Faz 10'da gelecek; test kurulumu doğrudan rol veriyor.
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

    const bookings = app.get(BookingsService);
    for (const to of ['MATCHED', 'PROVIDER_PENDING'] as const) {
      await bookings.advanceBySystem({ bookingId: booking.body.id as string, to });
    }

    await http()
      .post(`${PREFIX}/bookings/${booking.body.id}/confirm`)
      .set('authorization', providerToken)
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

  async function authorize(fixture: Fixture): Promise<string> {
    const response = await http()
      .post(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
      .set('authorization', fixture.customerToken)
      .send({})
      .expect(201);
    return response.body.paymentId as string;
  }

  /** Hizmet gününü gerçek geçişlerle tamamlar: `COMPLETED`. */
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

  function signedWebhook(payload: Record<string, unknown>): {
    body: string;
    signature: string;
  } {
    const body = JSON.stringify(payload);
    return { body, signature: app.get(MockPaymentProvider).signPayload(body) };
  }

  async function externalPaymentId(paymentId: string): Promise<string> {
    const rows = await pool.query<{ external_payment_id: string }>(
      `SELECT external_payment_id FROM payments WHERE id = $1`,
      [paymentId],
    );
    return rows.rows[0]!.external_payment_id;
  }

  async function paymentStatus(paymentId: string): Promise<string> {
    const rows = await pool.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [
      paymentId,
    ]);
    return rows.rows[0]!.status;
  }

  describe('yetkilendirme', () => {
    it('onaylanmış rezervasyon için ödeme alınır ve rezervasyon planlanır', async () => {
      const fixture = await setupConfirmedBooking('authorize');

      const response = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
        .set('authorization', fixture.customerToken)
        .send({})
        .expect(201);

      // Tutar rezervasyondan gelir; istemci tutar göndermez.
      expect(response.body.amountMinor).toMatch(/^\d+$/);
      expect(Number(response.body.amountMinor)).toBeGreaterThan(0);
      expect(response.body.status).toBe('HELD');

      const booking = await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}`)
        .set('authorization', fixture.customerToken)
        .expect(200);
      expect(booking.body.status).toBe('SCHEDULED');
    });

    /**
     * Ödeme sağlayıcı onayından **önce** alınamaz: alınsaydı, eşleşme başarısız olduğunda
     * müşterinin limiti boşuna bloke edilmiş olurdu.
     */
    it('sağlayıcı onaylamadan ödeme alınamaz', async () => {
      const fixture = await setupConfirmedBooking('early');

      // Rezervasyonu onay öncesine döndürmek mümkün değil (geri geçiş yok), bu yüzden
      // iptal edilmiş bir rezervasyon üzerinden denenir: her ikisi de "CONFIRMED değil".
      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/cancel`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'vazgeçtim' })
        .expect(201);

      const response = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
        .set('authorization', fixture.customerToken)
        .send({})
        .expect(409);

      expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('rezervasyonun tarafı olmayan kullanıcı ödeme başlatamaz', async () => {
      const fixture = await setupConfirmedBooking('outsider');
      await register('pay-outsider');

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
        .set('authorization', bearer('pay-outsider'))
        .send({})
        .expect(404);
    });

    /**
     * T-38: at-least-once teslimli bir event veya çift tıklama, sağlayıcıya ikinci bir
     * `authorize` göndermemeli. Koruma `payment_commands` UNIQUE'inde.
     */
    it('ikinci yetkilendirme denemesi sağlayıcıya ikinci çağrı göndermez', async () => {
      const fixture = await setupConfirmedBooking('double-authorize');
      const paymentId = await authorize(fixture);

      const second = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
        .set('authorization', fixture.customerToken)
        .send({})
        .expect(409);

      expect(second.body.error.code).toBe('PAYMENT_ALREADY_AUTHORIZED');

      const commands = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM payment_commands
          WHERE payment_id = $1 AND operation = 'AUTHORIZE'`,
        [paymentId],
      );
      expect(commands.rows[0]?.count).toBe('1');
    });

    it('reddedilen ödeme FAILED olur ve yeni deneme mümkündür', async () => {
      const fixture = await setupConfirmedBooking('declined');
      app.get(MockPaymentProvider).setDeclineNext(true);

      const declined = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
        .set('authorization', fixture.customerToken)
        .send({})
        .expect(422);
      expect(declined.body.error.code).toBe('PAYMENT_DECLINED');

      // Kısmi unique index sayesinde ikinci deneme engellenmez: tek bir başarısız
      // yetkilendirme rezervasyonu kalıcı olarak ödenemez yapmamalı.
      const retry = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
        .set('authorization', fixture.customerToken)
        .send({})
        .expect(201);
      expect(retry.body.status).toBe('HELD');
    });
  });

  describe('webhook', () => {
    // T-09: aynı event iki kez → ikinci kez yan etki yok, yine 200.
    it('aynı event iki kez geldiğinde ikinci kez yan etki üretilmez', async () => {
      const fixture = await setupConfirmedBooking('duplicate-webhook');
      const paymentId = await authorize(fixture);
      const external = await externalPaymentId(paymentId);

      const event = signedWebhook({
        externalEventId: 'evt-duplicate-1',
        externalPaymentId: external,
        type: 'REFUNDED',
        amountMinor: '1',
        sequence: 10,
      });

      // Aynı olay iki kez teslim edilir (sağlayıcı retry'ı veya replay).
      for (let delivery = 0; delivery < 2; delivery += 1) {
        await http()
          .post(`${PREFIX}/payments/webhook`)
          .set('content-type', 'application/json')
          .set('x-signature', event.signature)
          .send(event.body)
          .expect(200);
      }

      // Olay bir kez kayıtlı: UNIQUE (provider, external_event_id).
      const events = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM payment_events WHERE external_event_id = $1`,
        ['evt-duplicate-1'],
      );
      expect(events.rows[0]?.count).toBe('1');

      // Ve yalnızca bir kez uygulandı: iade iki kez işlenmedi.
      const applied = await pool.query<{ applied: boolean; refunded_minor: string }>(
        `SELECT e.applied, p.refunded_minor
           FROM payment_events e JOIN payments p ON p.id = e.payment_id
          WHERE e.external_event_id = $1`,
        ['evt-duplicate-1'],
      );
      expect(applied.rows[0]?.applied).toBe(true);
      expect(applied.rows[0]?.refunded_minor).toBe('1');
    });

    it('imzasız veya yanlış imzalı webhook reddedilir', async () => {
      const fixture = await setupConfirmedBooking('bad-signature');
      const paymentId = await authorize(fixture);
      const external = await externalPaymentId(paymentId);
      const event = signedWebhook({
        externalEventId: 'evt-bad-sig',
        externalPaymentId: external,
        type: 'RELEASED',
      });

      await http()
        .post(`${PREFIX}/payments/webhook`)
        .set('content-type', 'application/json')
        .send(event.body)
        .expect(401);

      await http()
        .post(`${PREFIX}/payments/webhook`)
        .set('content-type', 'application/json')
        .set('x-signature', 'f'.repeat(64))
        .send(event.body)
        .expect(401);

      // Reddedilen webhook hiçbir şey kaydetmez.
      const events = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM payment_events`,
      );
      expect(events.rows[0]?.count).toBe('0');
      expect(await paymentStatus(paymentId)).toBe('HELD');
    });

    // T-10: gecikmiş event durumu geriye çekmemeli.
    it('sıra dışı gelen eski event durumu geriye çekmez', async () => {
      const fixture = await setupConfirmedBooking('out-of-order');
      const paymentId = await authorize(fixture);
      const external = await externalPaymentId(paymentId);

      // Ödeme HELD durumunda; gecikmiş bir `AUTHORIZED` olayı geliyor.
      const stale = signedWebhook({
        externalEventId: 'evt-stale-authorized',
        externalPaymentId: external,
        type: 'AUTHORIZED',
        sequence: 1,
      });

      await http()
        .post(`${PREFIX}/payments/webhook`)
        .set('content-type', 'application/json')
        .set('x-signature', stale.signature)
        .send(stale.body)
        .expect(200);

      expect(await paymentStatus(paymentId)).toBe('HELD');

      // Olay kaydedilir ama uygulanmaz ve reddi audit'lenir.
      const event = await pool.query<{ applied: boolean }>(
        `SELECT applied FROM payment_events WHERE external_event_id = $1`,
        ['evt-stale-authorized'],
      );
      expect(event.rows[0]?.applied).toBe(false);

      const audit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
          WHERE action = 'PAYMENT_EVENT_REJECTED' AND entity_id = $1`,
        [paymentId],
      );
      expect(audit.rows[0]?.count).toBe('1');
    });

    it('bilinmeyen ödemeye ait event kaydedilir ama uygulanmaz', async () => {
      await setupConfirmedBooking('unknown-payment');

      const event = signedWebhook({
        externalEventId: 'evt-unknown',
        externalPaymentId: 'mock-pay-does-not-exist',
        type: 'RELEASED',
      });

      await http()
        .post(`${PREFIX}/payments/webhook`)
        .set('content-type', 'application/json')
        .set('x-signature', event.signature)
        .send(event.body)
        .expect(200);

      const row = await pool.query<{ applied: boolean; payment_id: string | null }>(
        `SELECT applied, payment_id FROM payment_events WHERE external_event_id = $1`,
        ['evt-unknown'],
      );
      expect(row.rows[0]?.applied).toBe(false);
      expect(row.rows[0]?.payment_id).toBeNull();
    });

    /**
     * ADR-0009 §6: webhook durumu **hizalar**, para hareketi başlatmaz. Sağlayıcıdan
     * gelen bir "RELEASED" bildirimi Emek'in `capture` çağrısını tetiklemez.
     */
    it('webhook giden ödeme komutu üretmez', async () => {
      const fixture = await setupConfirmedBooking('no-command-from-event');
      const paymentId = await authorize(fixture);
      const external = await externalPaymentId(paymentId);
      await completeService(fixture);

      const event = signedWebhook({
        externalEventId: 'evt-release-notice',
        externalPaymentId: external,
        type: 'RELEASED',
      });

      await http()
        .post(`${PREFIX}/payments/webhook`)
        .set('content-type', 'application/json')
        .set('x-signature', event.signature)
        .send(event.body)
        .expect(200);

      // Webhook, `SERVICE_COMPLETED → RELEASE_PENDING → RELEASED` yolunu atlayamaz:
      // geçiş tanımsızdır ve uygulanmaz.
      expect(await paymentStatus(paymentId)).toBe('SERVICE_COMPLETED');

      const captures = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM payment_commands
          WHERE payment_id = $1 AND operation = 'CAPTURE'`,
        [paymentId],
      );
      expect(captures.rows[0]?.count).toBe('0');
    });
  });

  describe('serbest bırakma', () => {
    it('hizmet tamamlanınca ödeme SERVICE_COMPLETED olur ama para çıkmaz', async () => {
      const fixture = await setupConfirmedBooking('service-completed');
      const paymentId = await authorize(fixture);
      await completeService(fixture);

      // Hizmet tamamlandı diye para otomatik çıkmaz: uyuşmazlık penceresi kalmalı.
      expect(await paymentStatus(paymentId)).toBe('SERVICE_COMPLETED');
      expect(
        (await pool.query(`SELECT 1 FROM payment_commands WHERE operation = 'CAPTURE'`)).rowCount,
      ).toBe(0);
    });

    it('operatör ödemeyi serbest bırakır ve rezervasyon SETTLED olur', async () => {
      const fixture = await setupConfirmedBooking('release');
      const paymentId = await authorize(fixture);
      await completeService(fixture);

      const response = await http()
        .post(`${PREFIX}/payments/${paymentId}/release`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(201);

      expect(response.body.status).toBe('RELEASED');
      expect(response.body.releasedAt).not.toBeNull();

      const booking = await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}`)
        .set('authorization', fixture.customerToken)
        .expect(200);
      expect(booking.body.status).toBe('SETTLED');
    });

    it('taraflar ödemeyi kendileri serbest bırakamaz', async () => {
      const fixture = await setupConfirmedBooking('release-forbidden');
      const paymentId = await authorize(fixture);
      await completeService(fixture);

      for (const token of [fixture.customerToken, fixture.providerToken]) {
        await http()
          .post(`${PREFIX}/payments/${paymentId}/release`)
          .set('authorization', token)
          .send({})
          .expect(403);
      }
    });

    it('para serbest bırakılmadan rezervasyon SETTLED olamaz', async () => {
      const fixture = await setupConfirmedBooking('settle-guard');
      await authorize(fixture);
      await completeService(fixture);

      await expect(
        app.get(BookingsService).advanceBySystem({
          bookingId: fixture.bookingId,
          to: 'SETTLED',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_NOT_RELEASED' });
    });

    // T-11: açık uyuşmazlık varken release bloklanır ve gerekçe audit'lenir.
    it('açık uyuşmazlık varken release bloklanır', async () => {
      const fixture = await setupConfirmedBooking('dispute-block');
      const paymentId = await authorize(fixture);
      await completeService(fixture);

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'SERVICE_QUALITY', description: 'hizmet eksik yapıldı' })
        .expect(201);

      const response = await http()
        .post(`${PREFIX}/payments/${paymentId}/release`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(409);

      expect(response.body.error.code).toBe('PAYMENT_RELEASE_BLOCKED');

      const audit = await pool.query<{ new_value: { reason: string } }>(
        `SELECT new_value FROM audit_logs
          WHERE action = 'PAYMENT_RELEASE_BLOCKED' AND entity_id = $1
          ORDER BY id DESC LIMIT 1`,
        [paymentId],
      );
      expect(audit.rows[0]?.new_value.reason).toBeDefined();

      // Bloklanan release hiçbir giden komut üretmemiş olmalı.
      const captures = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM payment_commands
          WHERE payment_id = $1 AND operation = 'CAPTURE'`,
        [paymentId],
      );
      expect(captures.rows[0]?.count).toBe('0');
    });

    // T-11 (ikinci yarısı): güvenlik askısı da release'i bloklar.
    it('SAFETY_HOLD varken release bloklanır', async () => {
      const fixture = await setupConfirmedBooking('safety-block');
      const paymentId = await authorize(fixture);

      const bookings = app.get(BookingsService);
      await bookings.advanceBySystem({ bookingId: fixture.bookingId, to: 'SAFETY_HOLD' });

      const response = await http()
        .post(`${PREFIX}/payments/${paymentId}/release`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(409);

      expect(response.body.error.code).toBe('PAYMENT_RELEASE_BLOCKED');
      // Güvenlik askısı parayı da dondurur.
      expect(await paymentStatus(paymentId)).toBe('DISPUTED');
    });
  });

  // T-34: yetkilendirme süresi dolmuşken release denemesi + re-authorization.
  describe('yetkilendirme süresi', () => {
    /**
     * Süre dolmasını beklemek günler sürerdi; bu yüzden **zaman** ileri alınır.
     * Durum makinesi atlanmaz: ödeme gerçek akışla `HELD` durumuna gelmiştir.
     */
    async function expireAuthorization(paymentId: string): Promise<void> {
      await pool.query(
        `UPDATE payments SET authorization_expires_at = now() - interval '1 hour' WHERE id = $1`,
        [paymentId],
      );
    }

    it('süresi dolmuş yetkilendirmede release denenmez', async () => {
      const fixture = await setupConfirmedBooking('expired-release');
      const paymentId = await authorize(fixture);
      await completeService(fixture);
      await expireAuthorization(paymentId);

      const response = await http()
        .post(`${PREFIX}/payments/${paymentId}/release`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(409);

      expect(response.body.error.code).toBe('PAYMENT_AUTHORIZATION_EXPIRED');

      // Sağlayıcıya hiç çağrı gitmemiş olmalı: "dene, reddedilirse görürüz" yaklaşımı
      // kullanıcıya anlamsız bir hata gösterirdi.
      const captures = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM payment_commands
          WHERE payment_id = $1 AND operation = 'CAPTURE'`,
        [paymentId],
      );
      expect(captures.rows[0]?.count).toBe('0');
    });

    it('yeniden yetkilendirme süreyi uzatır ve release yeniden mümkün olur', async () => {
      const fixture = await setupConfirmedBooking('reauthorize');
      const paymentId = await authorize(fixture);
      await completeService(fixture);
      await expireAuthorization(paymentId);

      const reauthorized = await http()
        .post(`${PREFIX}/payments/${paymentId}/reauthorize`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(201);

      expect(new Date(reauthorized.body.authorizationExpiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );

      const released = await http()
        .post(`${PREFIX}/payments/${paymentId}/release`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(201);
      expect(released.body.status).toBe('RELEASED');

      // Çift yetkilendirme oluşmadı: tek AUTHORIZE + tek REAUTHORIZE.
      const commands = await pool.query<{ operation: string; count: string }>(
        `SELECT operation, count(*)::text AS count FROM payment_commands
          WHERE payment_id = $1 GROUP BY operation ORDER BY operation`,
        [paymentId],
      );
      expect(commands.rows).toEqual([
        { operation: 'AUTHORIZE', count: '1' },
        { operation: 'CAPTURE', count: '1' },
        { operation: 'REAUTHORIZE', count: '1' },
      ]);
    });

    it('süresi dolmuş yetkilendirme zamanlanmış işle AUTHORIZATION_EXPIRED olur', async () => {
      const fixture = await setupConfirmedBooking('expire-job');
      const paymentId = await authorize(fixture);
      await expireAuthorization(paymentId);

      const expired = await app.get(PaymentsService).expireStaleAuthorizations();

      expect(expired).toBe(1);
      expect(await paymentStatus(paymentId)).toBe('AUTHORIZATION_EXPIRED');
    });
  });

  describe('iade', () => {
    it('kısmi iade ödemeyi canlı bırakır, tam iade REFUNDED yapar', async () => {
      const fixture = await setupConfirmedBooking('refund');
      const paymentId = await authorize(fixture);

      const amount = await pool.query<{ amount_minor: string }>(
        `SELECT amount_minor FROM payments WHERE id = $1`,
        [paymentId],
      );
      const total = BigInt(amount.rows[0]!.amount_minor);

      const partial = await http()
        .post(`${PREFIX}/payments/${paymentId}/refund`)
        .set('authorization', fixture.adminToken)
        .send({ amountMinor: (total / 2n).toString(), reason: 'kısmi memnuniyetsizlik' })
        .expect(201);

      expect(partial.body.status).toBe('HELD');
      expect(BigInt(partial.body.refundedMinor)).toBe(total / 2n);

      const full = await http()
        .post(`${PREFIX}/payments/${paymentId}/refund`)
        .set('authorization', fixture.adminToken)
        .send({ reason: 'kalan tutar iade' })
        .expect(201);

      expect(full.body.status).toBe('REFUNDED');
      expect(BigInt(full.body.refundedMinor)).toBe(total);
    });

    it('tutardan fazla iade reddedilir', async () => {
      const fixture = await setupConfirmedBooking('over-refund');
      const paymentId = await authorize(fixture);

      const amount = await pool.query<{ amount_minor: string }>(
        `SELECT amount_minor FROM payments WHERE id = $1`,
        [paymentId],
      );

      await http()
        .post(`${PREFIX}/payments/${paymentId}/refund`)
        .set('authorization', fixture.adminToken)
        .send({
          amountMinor: (BigInt(amount.rows[0]!.amount_minor) + 1n).toString(),
          reason: 'hatalı',
        })
        .expect(400);
    });
  });

  /**
   * Faz 5 review bulgusu C1: sonucu **bilinmeyen** bir çağrı (timeout/erişilemez) yeni bir
   * idempotency anahtarıyla tekrarlanırsa, sağlayıcı ilk çağrıyı işlemiş olabileceği için
   * para ikinci kez hareket eder.
   */
  describe('belirsiz sağlayıcı hatası sonrası yeniden deneme', () => {
    /** Kiralama süresini geçmişe çekerek "uçuşta değil, sonucu bilinmiyor" hâlini üretir. */
    async function expireCommandLease(paymentId: string, operation: string): Promise<void> {
      await pool.query(
        `UPDATE payment_commands SET created_at = now() - interval '5 minutes'
          WHERE payment_id = $1 AND operation = $2 AND status = 'PENDING'`,
        [paymentId, operation],
      );
    }

    it('capture timeout sonrası aynı idempotency anahtarı yeniden kullanılır', async () => {
      const fixture = await setupConfirmedBooking('capture-retry');
      const paymentId = await authorize(fixture);
      await completeService(fixture);

      app.get(MockPaymentProvider).setUnavailable(true);
      const failed = await http()
        .post(`${PREFIX}/payments/${paymentId}/release`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(503);
      expect(failed.body.error.code).toBe('SERVICE_DEGRADED');

      // Sonuç bilinmiyor: komut FAILED değil, PENDING kalır.
      const afterFailure = await pool.query<{ status: string; idempotency_key: string }>(
        `SELECT status, idempotency_key FROM payment_commands
          WHERE payment_id = $1 AND operation = 'CAPTURE'`,
        [paymentId],
      );
      expect(afterFailure.rows).toHaveLength(1);
      expect(afterFailure.rows[0]?.status).toBe('PENDING');

      // Kiralama süresi dolmadan ikinci istek reddedilir: çağrı hâlâ uçuşta olabilir.
      const inFlight = await http()
        .post(`${PREFIX}/payments/${paymentId}/release`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(409);
      expect(inFlight.body.error.code).toBe('PAYMENT_COMMAND_IN_FLIGHT');

      await expireCommandLease(paymentId, 'CAPTURE');
      app.get(MockPaymentProvider).setUnavailable(false);

      const released = await http()
        .post(`${PREFIX}/payments/${paymentId}/release`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(201);
      expect(released.body.status).toBe('RELEASED');

      // Kritik: tek bir CAPTURE komutu ve **aynı** anahtar. Yeni anahtar üretilseydi
      // sağlayıcı ikinci çağrıyı yeni bir işlem sayar ve para iki kez çıkardı.
      const afterRetry = await pool.query<{ status: string; idempotency_key: string }>(
        `SELECT status, idempotency_key FROM payment_commands
          WHERE payment_id = $1 AND operation = 'CAPTURE'`,
        [paymentId],
      );
      expect(afterRetry.rows).toHaveLength(1);
      expect(afterRetry.rows[0]?.status).toBe('SUCCEEDED');
      expect(afterRetry.rows[0]?.idempotency_key).toBe(afterFailure.rows[0]?.idempotency_key);
    });

    it('iade timeout sonrası aynı anahtarla devam eder, çift iade olmaz', async () => {
      const fixture = await setupConfirmedBooking('refund-retry');
      const paymentId = await authorize(fixture);

      app.get(MockPaymentProvider).setUnavailable(true);
      await http()
        .post(`${PREFIX}/payments/${paymentId}/refund`)
        .set('authorization', fixture.adminToken)
        .send({ amountMinor: '1000', reason: 'deneme' })
        .expect(503);

      await expireCommandLease(paymentId, 'REFUND');
      app.get(MockPaymentProvider).setUnavailable(false);

      const refunded = await http()
        .post(`${PREFIX}/payments/${paymentId}/refund`)
        .set('authorization', fixture.adminToken)
        .send({ amountMinor: '1000', reason: 'deneme' })
        .expect(201);
      expect(refunded.body.refundedMinor).toBe('1000');

      const commands = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM payment_commands
          WHERE payment_id = $1 AND operation = 'REFUND'`,
        [paymentId],
      );
      expect(commands.rows[0]?.count).toBe('1');
    });

    it('kesin red sonrası yeni deneme yeni anahtar üretir', async () => {
      // Sağlayıcı "işlemedim" dediğinde aynı anahtarı tekrar kullanmak, sağlayıcının
      // reddi önbelleklemesi hâlinde yeni denemeyi de reddettirirdi.
      const fixture = await setupConfirmedBooking('decline-new-key');
      app.get(MockPaymentProvider).setDeclineNext(true);

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
        .set('authorization', fixture.customerToken)
        .send({})
        .expect(422);

      const first = await pool.query<{ status: string }>(
        `SELECT status FROM payment_commands WHERE operation = 'AUTHORIZE'`,
      );
      expect(first.rows[0]?.status).toBe('FAILED');

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
        .set('authorization', fixture.customerToken)
        .send({})
        .expect(201);

      const keys = await pool.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM payment_commands WHERE operation = 'AUTHORIZE'`,
      );
      expect(new Set(keys.rows.map((row) => row.idempotency_key)).size).toBe(keys.rows.length);
    });
  });

  /**
   * Faz 5 review bulgusu C2: dondurulmuş ödeme çözülebilmeli. Çözülemezse sağlayıcı
   * lehine karar verilmiş bir uyuşmazlıkta para kalıcı olarak kilitli kalırdı.
   */
  describe('dondurma çözülmesi', () => {
    it('sağlayıcı lehine karar sonrası para serbest bırakılabilir', async () => {
      const fixture = await setupConfirmedBooking('unfreeze-release');
      const paymentId = await authorize(fixture);
      await completeService(fixture);

      const dispute = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'SERVICE_QUALITY' })
        .expect(201);

      expect(await paymentStatus(paymentId)).toBe('DISPUTED');

      await http()
        .post(`${PREFIX}/disputes/${dispute.body.id}/resolve`)
        .set('authorization', fixture.adminToken)
        .send({ status: 'RESOLVED_PROVIDER', resolution: 'kanıtlarla doğrulandı' })
        .expect(201);

      // Ödeme dondurulduğu duruma döndü ve release yeniden mümkün.
      expect(await paymentStatus(paymentId)).toBe('SERVICE_COMPLETED');

      const released = await http()
        .post(`${PREFIX}/payments/${paymentId}/release`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(201);
      expect(released.body.status).toBe('RELEASED');
    });

    it('güvenlik yanlış alarmı temizlenince para çözülür ve akış tamamlanır', async () => {
      const fixture = await setupConfirmedBooking('unfreeze-safety');
      const paymentId = await authorize(fixture);
      const bookings = app.get(BookingsService);

      // Hizmet başlar, sonra güvenlik askısı konur.
      for (const to of ['PROVIDER_ARRIVING', 'CHECKED_IN', 'IN_PROGRESS'] as const) {
        await http()
          .post(`${PREFIX}/bookings/${fixture.bookingId}/transitions`)
          .set('authorization', fixture.providerToken)
          .send({ to })
          .expect(201);
      }

      await bookings.advanceBySystem({ bookingId: fixture.bookingId, to: 'SAFETY_HOLD' });
      expect(await paymentStatus(paymentId)).toBe('DISPUTED');

      // Operatör yanlış alarmı temizler: ödeme dondurulduğu duruma (HELD) döner.
      // Askıdan çıkış yalnızca `ADMIN` aktörüne açıktır (ADR-0006).
      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/transitions`)
        .set('authorization', fixture.adminToken)
        .send({ to: 'IN_PROGRESS' })
        .expect(201);
      expect(await paymentStatus(paymentId)).toBe('HELD');

      // Akış normal şekilde tamamlanabiliyor ve para çıkabiliyor.
      for (const to of ['CHECKED_OUT'] as const) {
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

      expect(await paymentStatus(paymentId)).toBe('SERVICE_COMPLETED');
      await http()
        .post(`${PREFIX}/payments/${paymentId}/release`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(201);
    });

    it('ikinci açık uyuşmazlık varken çözüm ödemeyi serbest bırakmaz', async () => {
      const fixture = await setupConfirmedBooking('unfreeze-guard');
      const paymentId = await authorize(fixture);
      await completeService(fixture);

      const dispute = await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'DAMAGE' })
        .expect(201);

      await http()
        .post(`${PREFIX}/disputes/${dispute.body.id}/resolve`)
        .set('authorization', fixture.adminToken)
        .send({ status: 'RESOLVED_PROVIDER', resolution: 'kapatıldı' })
        .expect(201);

      // Yeni bir uyuşmazlık açılırsa ödeme tekrar dondurulur ve release yine bloklanır.
      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/disputes`)
        .set('authorization', fixture.providerToken)
        .send({ reason: 'BILLING' })
        .expect(201);

      expect(await paymentStatus(paymentId)).toBe('DISPUTED');
      const blocked = await http()
        .post(`${PREFIX}/payments/${paymentId}/release`)
        .set('authorization', fixture.adminToken)
        .send({})
        .expect(409);
      expect(blocked.body.error.code).toBe('PAYMENT_RELEASE_BLOCKED');
    });
  });

  describe('görünürlük', () => {
    it('taraflar ödemeyi görür, üçüncü kişi göremez', async () => {
      const fixture = await setupConfirmedBooking('visibility');
      await authorize(fixture);
      await register('pay-stranger');

      for (const token of [fixture.customerToken, fixture.providerToken]) {
        const response = await http()
          .get(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
          .set('authorization', token)
          .expect(200);
        // Sağlayıcı referansı istemciye sızmaz.
        expect(response.body.externalPaymentId).toBeUndefined();
      }

      await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}/payment`)
        .set('authorization', bearer('pay-stranger'))
        .expect(404);
    });

    it('kart verisi hiçbir ödeme kolonunda tutulmaz', async () => {
      // Şema seviyesinde kontrol: PAN/CVV taşıyacak bir kolon eklenirse test kırılır.
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name IN ('payments', 'payment_events', 'payment_commands')`,
      );
      const names = columns.rows.map((row) => row.column_name.toLowerCase());

      for (const forbidden of ['pan', 'card_number', 'cvv', 'cvc', 'expiry', 'card_holder']) {
        expect(names).not.toContain(forbidden);
      }
    });
  });
});
