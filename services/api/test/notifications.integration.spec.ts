import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppConfigService } from '../src/common/config/app-config.service';
import { EventConsumerRunner } from '../src/common/events/event-consumer-runner';
import { ROOT_LOGGER } from '../src/common/logging/logging.tokens';
import { RetentionService } from '../src/common/retention/retention.service';
import { MAX_DEVICES_PER_USER } from '../src/notifications/devices.service';
import { NotificationDeliveryWorker } from '../src/notifications/notification-delivery.worker';
import {
  EMAIL_SENDER,
  SMS_SENDER,
  type EmailSender,
  type SmsSender,
} from '../src/notifications/message-senders';
import { PUSH_SENDER, type PushSender } from '../src/notifications/push-sender';
import { NotificationJobsRepository } from '../src/ops/notification-jobs.repository';
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
 * Push bildirimleri (Faz 16, R-77, R-76 düzeltmesi): cihaz kaydı, alıcı çözümü, teslimat
 * worker'ı ve retention.
 */
describe('notifications (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let runner: EventConsumerRunner;
  let worker: NotificationDeliveryWorker;
  let sender: PushSender;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    redis = createRedis();
    runner = app.get(EventConsumerRunner);
    worker = app.get(NotificationDeliveryWorker);
    sender = app.get<PushSender>(PUSH_SENDER);
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);
    jest.restoreAllMocks();
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

  async function registerDevice(subject: string, token: string): Promise<string> {
    const response = await http()
      .post(`${PREFIX}/users/me/devices`)
      .set('authorization', bearer(subject))
      .send({ token, platform: 'ANDROID' })
      .expect(200);
    return response.body.id as string;
  }

  /** Sağlayıcı atanmış bir rezervasyon satırı (bildirim alıcı çözümü için yeterli). */
  async function booking(): Promise<{ bookingId: string; customerId: string; providerId: string }> {
    const customerId = await register('nt-customer');
    const providerId = await register('nt-provider');
    // Rezervasyonun tarafları profildir (FK customer_profiles / provider_profiles).
    await http()
      .post(`${PREFIX}/customers/profile`)
      .set('authorization', bearer('nt-customer'))
      .send({ displayName: 'Bildirim Müşteri' })
      .expect(201);
    await http()
      .post(`${PREFIX}/providers/profile`)
      .set('authorization', bearer('nt-provider'))
      .send({ displayName: 'Bildirim Sağlayıcı' })
      .expect(201);
    const address = await http()
      .post(`${PREFIX}/addresses`)
      .set('authorization', bearer('nt-customer'))
      .send({
        city: 'İstanbul',
        district: 'Kadıköy',
        line: 'Moda Caddesi 1',
        latitude: 40.99,
        longitude: 29.03,
      })
      .expect(201);
    const service = await pool.query<{ id: string }>(`SELECT id FROM services LIMIT 1`);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO bookings
         (customer_id, provider_id, service_id, address_id, scheduled_start, scheduled_end,
          price_minor, status)
       VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day 3 hours',
               96000, 'CONFIRMED')
       RETURNING id`,
      [customerId, providerId, service.rows[0]!.id, address.body.id],
    );
    return { bookingId: inserted.rows[0]!.id, customerId, providerId };
  }

  const event = (eventType: string, payload: Record<string, unknown>) => ({
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    aggregateType: 'booking',
    aggregateId: randomUUID(),
    producer: 'test',
    correlationId: null,
    payload,
  });

  async function jobs(eventId: string) {
    return (
      await pool.query<{
        recipient_user_id: string;
        channel: string;
        status: string;
        template_data: Record<string, unknown>;
        last_error: string | null;
        attempts: number;
      }>(`SELECT * FROM notification_jobs WHERE event_id = $1 ORDER BY recipient_user_id`, [
        eventId,
      ])
    ).rows;
  }

  describe('cihaz kaydı', () => {
    it('upsert: aynı token başka hesapla kaydedilirse yeni kullanıcıya taşınır; token yanıtta dönmez', async () => {
      const a = await register('dev-a');
      const b = await register('dev-b');
      const first = await http()
        .post(`${PREFIX}/users/me/devices`)
        .set('authorization', bearer('dev-a'))
        .send({ token: 'fcm-token-1', platform: 'IOS' })
        .expect(200);
      expect(first.body).not.toHaveProperty('token');

      await registerDevice('dev-b', 'fcm-token-1');
      const rows = await pool.query(`SELECT user_id FROM user_devices WHERE token = 'fcm-token-1'`);
      expect(rows.rows).toEqual([{ user_id: b }]);
      expect(a).not.toBe(b);
    });

    it('silme yalnız kendi cihazında etkilidir; kimliksiz istek reddedilir', async () => {
      await register('dev-c');
      await register('dev-d');
      const id = await registerDevice('dev-c', 'fcm-token-c');
      await http()
        .delete(`${PREFIX}/users/me/devices/${id}`)
        .set('authorization', bearer('dev-d'))
        .expect(204);
      expect((await pool.query(`SELECT 1 FROM user_devices WHERE id = $1`, [id])).rowCount).toBe(1);

      await http()
        .delete(`${PREFIX}/users/me/devices/${id}`)
        .set('authorization', bearer('dev-c'))
        .expect(204);
      expect((await pool.query(`SELECT 1 FROM user_devices WHERE id = $1`, [id])).rowCount).toBe(0);

      await http()
        .post(`${PREFIX}/users/me/devices`)
        .send({ token: 'x', platform: 'IOS' })
        .expect(401);
    });

    it('kullanıcı başına üst sınır: en uzun süredir görülmeyen düşer, yenisi kalır', async () => {
      await register('cap-user');
      for (let i = 0; i < MAX_DEVICES_PER_USER; i += 1) {
        await registerDevice('cap-user', `cap-token-${i}`);
      }
      await pool.query(
        `UPDATE user_devices SET last_seen_at = now() - interval '1 day' WHERE token = 'cap-token-3'`,
      );
      await registerDevice('cap-user', 'cap-token-new');
      const tokens = (
        await pool.query<{ token: string }>(`SELECT token FROM user_devices`)
      ).rows.map((r) => r.token);
      expect(tokens).toHaveLength(MAX_DEVICES_PER_USER);
      expect(tokens).toContain('cap-token-new');
      expect(tokens).not.toContain('cap-token-3');
    });

    it('doğrulama: bilinmeyen platform ve boş token reddedilir', async () => {
      await register('dev-e');
      for (const body of [
        { token: 'x', platform: 'WINDOWS' },
        { token: '', platform: 'IOS' },
      ]) {
        await http()
          .post(`${PREFIX}/users/me/devices`)
          .set('authorization', bearer('dev-e'))
          .send(body)
          .expect(400)
          .expect((res) => expect(res.body.error.code).toBe('VALIDATION_FAILED'));
      }
    });
  });

  describe('alıcı çözümü (R-76)', () => {
    it('BookingConfirmed → müşteri; iş PUSH kanalında, alıcı gerçek kullanıcı', async () => {
      const { bookingId, customerId } = await booking();
      const e = event('BookingConfirmed', { bookingId });
      expect((await runner.processEvent(e)).action).toBe('ACK');
      const rows = await jobs(e.eventId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        recipient_user_id: customerId,
        channel: 'PUSH',
        template_data: { bookingId, audience: 'CUSTOMER' },
      });
    });

    it('BookingCancelled → iki taraf, her biri kendi tarafıyla', async () => {
      const { bookingId, customerId, providerId } = await booking();
      const e = event('BookingCancelled', { bookingId });
      await runner.processEvent(e);
      const audiences = Object.fromEntries(
        (await jobs(e.eventId)).map((r) => [r.recipient_user_id, r.template_data['audience']]),
      );
      expect(audiences).toEqual({ [customerId]: 'CUSTOMER', [providerId]: 'PROVIDER' });
    });

    it('PaymentAuthorized → sağlayıcı; DisputeResolved → iki taraf', async () => {
      const { bookingId, customerId, providerId } = await booking();
      const paid = event('PaymentAuthorized', { bookingId });
      await runner.processEvent(paid);
      expect((await jobs(paid.eventId)).map((r) => r.recipient_user_id)).toEqual([providerId]);

      const resolved = event('DisputeResolved', { bookingId, disputeId: randomUUID() });
      await runner.processEvent(resolved);
      const pushJobs = (await jobs(resolved.eventId)).filter((r) => r.channel === 'PUSH');
      expect(pushJobs.map((r) => r.recipient_user_id).sort()).toEqual(
        [customerId, providerId].sort(),
      );
    });

    it('SafetyAlertRaised taraflara bildirim üretmez (ADR-0019 §9); BookingCreated da', async () => {
      const { bookingId } = await booking();
      for (const type of ['SafetyAlertRaised', 'BookingCreated']) {
        const e = event(type, { bookingId, safetySessionId: randomUUID(), severity: 'HIGH' });
        await runner.processEvent(e);
        expect(await jobs(e.eventId)).toHaveLength(0);
      }
    });

    it('rezervasyon yoksa iş uydurulmaz; bookingId bozuksa kalıcı hata (DLQ)', async () => {
      const missing = event('BookingConfirmed', { bookingId: randomUUID() });
      expect((await runner.processEvent(missing)).action).toBe('ACK');
      expect(await jobs(missing.eventId)).toHaveLength(0);

      const broken = event('BookingConfirmed', { bookingId: 'not-a-uuid' });
      // Kalıcı hata ACK'lenir ama DLQ'ya aynı transaction'da yazılır (sonsuz yeniden teslim yok).
      expect((await runner.processEvent(broken)).action).toBe('ACK');
      expect(await jobs(broken.eventId)).toHaveLength(0);
      const dlq = await pool.query(
        `SELECT 1 FROM dead_letter_events WHERE event_id = $1 AND consumer = 'notification-job'`,
        [broken.eventId],
      );
      expect(dlq.rowCount).toBe(1);
    });
  });

  describe('teslimat worker', () => {
    async function pendingJob(): Promise<{ eventId: string; customerId: string }> {
      const { bookingId, customerId } = await booking();
      const e = event('BookingConfirmed', { bookingId });
      await runner.processEvent(e);
      return { eventId: e.eventId, customerId };
    }

    it('cihaza gönderir ve SENT yazar; aynı iş ikinci turda alınmaz', async () => {
      const { eventId } = await pendingJob();
      await registerDevice('nt-customer', 'fcm-customer');
      const send = jest.spyOn(sender, 'send');

      expect(await worker.tick()).toEqual({ sent: 1, failed: 0, retried: 0 });
      expect(send).toHaveBeenCalledWith(
        'fcm-customer',
        expect.objectContaining({
          title: 'Randevunuz onaylandı',
          route: expect.stringMatching(/^\/randevular\//),
        }),
      );
      expect((await jobs(eventId))[0]).toMatchObject({ status: 'SENT', attempts: 1 });
      expect(await worker.tick()).toEqual({ sent: 0, failed: 0, retried: 0 });
    });

    it('bayat durum-duyarlı iş gönderilmez: FAILED/STALE (R-114)', async () => {
      const { eventId } = await pendingJob();
      await registerDevice('nt-customer', 'fcm-customer');
      await pool.query(
        `UPDATE bookings SET status = 'PAYMENT_AUTHORIZED' WHERE id = (
           SELECT (template_data->>'bookingId')::uuid FROM notification_jobs WHERE event_id = $1)`,
        [eventId],
      );
      const send = jest.spyOn(sender, 'send');
      expect(await worker.tick()).toEqual({ sent: 0, failed: 1, retried: 0 });
      expect(send).not.toHaveBeenCalled();
      expect((await jobs(eventId))[0]).toMatchObject({ status: 'FAILED', last_error: 'STALE' });
    });

    it('cihaz yoksa FAILED/NO_DEVICE (tekrar denenmez)', async () => {
      const { eventId } = await pendingJob();
      expect(await worker.tick()).toEqual({ sent: 0, failed: 1, retried: 0 });
      expect((await jobs(eventId))[0]).toMatchObject({ status: 'FAILED', last_error: 'NO_DEVICE' });
    });

    it('geçersiz token cihaz kaydını siler', async () => {
      const { eventId } = await pendingJob();
      await registerDevice('nt-customer', 'stale-token');
      jest.spyOn(sender, 'send').mockResolvedValue('INVALID_TOKEN');
      await worker.tick();
      expect(
        (await pool.query(`SELECT 1 FROM user_devices WHERE token = 'stale-token'`)).rowCount,
      ).toBe(0);
      expect((await jobs(eventId))[0]).toMatchObject({
        status: 'FAILED',
        last_error: 'INVALID_TOKENS',
      });
    });

    it('geçici hatada geri çekilir: iş PENDING kalır ama zamanı gelene dek alınmaz', async () => {
      const { eventId } = await pendingJob();
      await registerDevice('nt-customer', 'fcm-customer');
      jest.spyOn(sender, 'send').mockResolvedValue('TRANSIENT');

      expect(await worker.tick()).toEqual({ sent: 0, failed: 0, retried: 1 });
      expect((await jobs(eventId))[0]).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        last_error: 'TRANSIENT',
      });
      expect(await worker.tick()).toEqual({ sent: 0, failed: 0, retried: 0 }); // geri çekilmede

      // Zamanı gelince (ör. 5. denemede) FAILED olur.
      await pool.query(
        `UPDATE notification_jobs SET attempts = 4, next_attempt_at = now() WHERE event_id = $1`,
        [eventId],
      );
      await worker.tick();
      expect((await jobs(eventId))[0]).toMatchObject({
        status: 'FAILED',
        last_error: 'MAX_ATTEMPTS',
      });
    });

    it('kalıcı ret (ör. bozuk yük) cihazı silmez: FAILED/PROVIDER_REJECTED', async () => {
      const { eventId } = await pendingJob();
      await registerDevice('nt-customer', 'fcm-customer');
      jest.spyOn(sender, 'send').mockResolvedValue('PERMANENT');
      await worker.tick();
      expect((await jobs(eventId))[0]).toMatchObject({
        status: 'FAILED',
        last_error: 'PROVIDER_REJECTED',
      });
      expect((await pool.query(`SELECT 1 FROM user_devices`)).rowCount).toBe(1);
    });

    it('geçersiz token silinirken token bu arada başka hesaba taşındıysa yeni kayıt korunur', async () => {
      await pendingJob();
      await registerDevice('nt-customer', 'shared-phone');
      jest.spyOn(sender, 'send').mockImplementation(async () => {
        // Gönderim sürerken aynı telefonda sağlayıcı hesabıyla giriş yapıldı.
        await registerDevice('nt-provider', 'shared-phone');
        return 'INVALID_TOKEN';
      });
      await worker.tick();
      const left = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM user_devices WHERE token = 'shared-phone'`,
      );
      expect(left.rowCount).toBe(1);
    });

    it('kira başka tura geçtiyse sonuç yazılmaz (sahibin sonucu ezilmez)', async () => {
      const { eventId } = await pendingJob();
      await registerDevice('nt-customer', 'fcm-customer');
      jest.spyOn(sender, 'send').mockImplementation(async () => {
        // Bu tur kirayı aştı; başka bir instance işi yeniden aldı (kira yenilendi).
        await pool.query(
          `UPDATE notification_jobs SET next_attempt_at = now() + interval '5 minutes'
            WHERE event_id = $1`,
          [eventId],
        );
        return 'SENT';
      });
      expect(await worker.tick()).toEqual({ sent: 0, failed: 0, retried: 0 });
      expect((await jobs(eventId))[0]).toMatchObject({ status: 'PENDING', attempts: 0 });
    });

    it('operatör yeniden denemesi deneme sayacını sıfırlar', async () => {
      const { eventId } = await pendingJob();
      await pool.query(
        `UPDATE notification_jobs SET status = 'FAILED', attempts = 5, last_error = 'MAX_ATTEMPTS'
          WHERE event_id = $1`,
        [eventId],
      );
      const id = (
        await pool.query<{ id: string }>(
          `SELECT id::text FROM notification_jobs WHERE event_id = $1`,
          [eventId],
        )
      ).rows[0]!.id;
      const client = await pool.connect();
      try {
        expect(await app.get(NotificationJobsRepository).retry(client, id)).toBe(true);
      } finally {
        client.release();
      }
      expect((await jobs(eventId))[0]).toMatchObject({ status: 'PENDING', attempts: 0 });
    });

    it('eşzamanlı iki tur aynı işi iki kez göndermez', async () => {
      await pendingJob();
      await registerDevice('nt-customer', 'fcm-customer');
      // İkinci instance'ı taklit eden ayrı bir worker (aynı veritabanı).
      const other = new NotificationDeliveryWorker(
        pool,
        app.get(ROOT_LOGGER),
        sender,
        app.get(SMS_SENDER),
        app.get(EMAIL_SENDER),
        app.get(AppConfigService),
      );
      const send = jest.spyOn(sender, 'send');
      await Promise.all([worker.tick(), other.tick()]);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe('SMS / e-posta (R-77)', () => {
    let sms: SmsSender;
    let email: EmailSender;
    beforeAll(() => {
      sms = app.get<SmsSender>(SMS_SENDER);
      email = app.get<EmailSender>(EMAIL_SENDER);
    });

    const channelsOf = async (eventId: string) =>
      (await jobs(eventId)).map((r) => `${r.channel}:${r.recipient_user_id}`).sort();

    it('kanal politikası: iptal → push + SMS; itiraz sonucu → push + e-posta; onay → yalnız push', async () => {
      const { bookingId, customerId, providerId } = await booking();
      const cancelled = event('BookingCancelled', { bookingId });
      const resolved = event('DisputeResolved', { bookingId, disputeId: randomUUID() });
      const confirmed = event('BookingConfirmed', { bookingId });
      for (const e of [cancelled, resolved, confirmed]) await runner.processEvent(e);

      expect(await channelsOf(cancelled.eventId)).toEqual(
        [
          `PUSH:${customerId}`,
          `PUSH:${providerId}`,
          `SMS:${customerId}`,
          `SMS:${providerId}`,
        ].sort(),
      );
      expect(await channelsOf(resolved.eventId)).toEqual(
        [
          `EMAIL:${customerId}`,
          `EMAIL:${providerId}`,
          `PUSH:${customerId}`,
          `PUSH:${providerId}`,
        ].sort(),
      );
      expect(await channelsOf(confirmed.eventId)).toEqual([`PUSH:${customerId}`]);
    });

    it('kanal disabled ise o kanala iş üretilmez', async () => {
      const env = app.get(AppConfigService).env;
      jest.replaceProperty(env, 'SMS_PROVIDER', 'disabled');
      const { bookingId } = await booking();
      const e = event('BookingCancelled', { bookingId });
      await runner.processEvent(e);
      expect((await jobs(e.eventId)).map((r) => r.channel)).toEqual(['PUSH', 'PUSH']);
    });

    it('gönderim anında iletişim bilgisi users tablosundan okunur; işe yazılmaz', async () => {
      const { bookingId, providerId } = await booking();
      await pool.query(`UPDATE users SET phone = '+905551112233' WHERE id = $1`, [providerId]);
      const e = event('BookingMatched', { bookingId });
      await pool.query(`UPDATE bookings SET status = 'PROVIDER_PENDING' WHERE id = $1`, [
        bookingId,
      ]);
      await runner.processEvent(e);
      const sendSms = jest.spyOn(sms, 'send');

      await worker.tick();
      expect(sendSms).toHaveBeenCalledWith('+905551112233', {
        text: expect.stringMatching(/^Emek: /),
      });
      const smsJob = (await jobs(e.eventId)).find((r) => r.channel === 'SMS');
      expect(smsJob).toMatchObject({ status: 'SENT' });
      // Numaranın kendisi aranır: kısa bir parça ('555') işteki rastgele UUID'de tesadüfen
      // geçebiliyordu (CI'da bir kez oldu). Bu dize +90'lı ve +90'sız biçimi birlikte yakalar.
      const stored = JSON.stringify(smsJob?.template_data);
      expect(stored).not.toContain('5551112233');
      expect(stored).not.toMatch(/"phone"/);
    });

    it('e-posta alıcının adresine gider; adres yoksa FAILED/NO_CONTACT', async () => {
      const { bookingId, customerId, providerId } = await booking();
      await pool.query(`UPDATE users SET email = 'musteri@example.test' WHERE id = $1`, [
        customerId,
      ]);
      await pool.query(`UPDATE users SET email = NULL, phone = '+905551112244' WHERE id = $1`, [
        providerId,
      ]);
      const e = event('DisputeResolved', { bookingId, disputeId: randomUUID() });
      await runner.processEvent(e);
      const sendEmail = jest.spyOn(email, 'send');

      await worker.tick();
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail).toHaveBeenCalledWith(
        'musteri@example.test',
        expect.objectContaining({ subject: 'İtiraz sonuçlandı' }),
      );
      const emailJobs = (await jobs(e.eventId)).filter((r) => r.channel === 'EMAIL');
      expect(Object.fromEntries(emailJobs.map((r) => [r.recipient_user_id, r.last_error]))).toEqual(
        {
          [customerId]: null,
          [providerId]: 'NO_CONTACT',
        },
      );
    });

    it.each(['DELETED', 'SUSPENDED'])('%s hesaba gönderilmez', async (status) => {
      const { bookingId, customerId } = await booking();
      const e = event('PaymentRefunded', { bookingId, paymentId: randomUUID() });
      await runner.processEvent(e);
      await pool.query(`UPDATE users SET status = $2 WHERE id = $1`, [customerId, status]);
      const sendEmail = jest.spyOn(email, 'send');
      await worker.tick();
      expect(sendEmail).not.toHaveBeenCalled();
      expect((await jobs(e.eventId)).find((r) => r.channel === 'EMAIL')).toMatchObject({
        status: 'FAILED',
        last_error: 'NO_CONTACT',
      });
    });

    it('geçersiz numara iletişim bilgisini silmez: FAILED/INVALID_RECIPIENT; geçici hata geri çekilir', async () => {
      const { bookingId, customerId, providerId } = await booking();
      await pool.query(`UPDATE users SET phone = '+905551112255' WHERE id = $1`, [customerId]);
      await pool.query(`UPDATE users SET phone = '+905551112266' WHERE id = $1`, [providerId]);
      const e = event('BookingCancelled', { bookingId });
      await runner.processEvent(e);
      jest
        .spyOn(sms, 'send')
        .mockImplementation(async (phone) =>
          phone === '+905551112255' ? 'INVALID_RECIPIENT' : 'TRANSIENT',
        );

      await worker.tick();
      const smsJobs = Object.fromEntries(
        (await jobs(e.eventId))
          .filter((r) => r.channel === 'SMS')
          .map((r) => [r.recipient_user_id, `${r.status}/${r.last_error}`]),
      );
      expect(smsJobs).toEqual({
        [customerId]: 'FAILED/INVALID_RECIPIENT',
        [providerId]: 'PENDING/TRANSIENT',
      });
      const phone = await pool.query(`SELECT phone FROM users WHERE id = $1`, [customerId]);
      expect(phone.rows[0].phone).toBe('+905551112255');
    });
  });

  describe('retention', () => {
    it('bayat token silinir, taze kalır', async () => {
      await register('ret-a');
      await registerDevice('ret-a', 'fresh-token');
      await registerDevice('ret-a', 'old-token');
      await pool.query(
        `UPDATE user_devices SET last_seen_at = now() - interval '200 days' WHERE token = 'old-token'`,
      );
      const result = await app.get(RetentionService).sweep();
      expect(result.deviceTokens).toBe(1);
      const left = await pool.query(`SELECT token FROM user_devices`);
      expect(left.rows).toEqual([{ token: 'fresh-token' }]);
    });

    it('hesap anonimleştirilince tüm cihaz kayıtları silinir', async () => {
      const userId = await register('ret-deleted');
      await registerDevice('ret-deleted', 'deleted-user-token');
      await pool.query(`UPDATE users SET deleted_at = now() - interval '400 days' WHERE id = $1`, [
        userId,
      ]);
      const result = await app.get(RetentionService).sweep();
      expect(result.anonymizedUsers).toBe(1);
      expect((await pool.query(`SELECT 1 FROM user_devices`)).rowCount).toBe(0);
    });
  });
});
