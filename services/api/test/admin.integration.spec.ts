import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { MockIdentityProvider } from '../src/identity/mock-identity-provider';
import {
  PREFIX,
  auditActionsSince,
  bearer,
  clearRateLimits,
  createPool,
  createRedis,
  createTestApp,
  currentAuditMaxId,
  ensureCatalog,
  resetDomainTables,
} from './helpers/test-app';

/**
 * Faz 10 — Admin/Operations API.
 *
 * Exit kriterleri: her admin aksiyonu `audit_logs`'ta; `SUPPORT` rolü yıkıcı
 * aksiyon yapamıyor; hassas veri erişimi loglanıyor. Bu dosya sekiz alt kapsamın
 * her birinde en az bir pozitif akışı ve RBAC sınırını doğrular — mevcut
 * fazlarda zaten test edilmiş davranışları (ör. dispute resolve'un kendisi)
 * tekrar etmez, yalnızca Faz 10'da eklenen admin yüzeyini kapsar.
 */
describe('admin / operations API (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let identityProvider: MockIdentityProvider;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    redis = createRedis();
    identityProvider = app.get(MockIdentityProvider);
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);
    identityProvider.setUnavailable(false);
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

  async function grant(userId: string, role: 'ADMIN' | 'SUPPORT'): Promise<void> {
    await pool.query(
      `INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, role],
    );
  }

  // --- 1. Identity: hesap kurtarma kuyruğu ---

  describe('kimlik: kurtarma kuyruğu', () => {
    async function createPendingRequest(seed: string): Promise<{ targetUserId: string }> {
      await register(`adm-owner-${seed}`);
      const ownerToken = bearer(`adm-owner-${seed}`);
      const ownerSession = await http()
        .post(`${PREFIX}/verification/session`)
        .set('authorization', ownerToken)
        .send({ method: 'NFC_EID' })
        .expect(201);
      const ownerExternal = await pool.query<{ external_session_id: string }>(
        `SELECT external_session_id FROM verification_attempts WHERE id = $1`,
        [ownerSession.body.attemptId],
      );
      const ownerBody = JSON.stringify({
        externalSessionId: ownerExternal.rows[0]?.external_session_id,
        outcome: 'VERIFIED',
        nationalId: `9${seed}`.padEnd(11, '0').slice(0, 11),
        assuranceLevel: 'HIGH',
      });
      await http()
        .post(`${PREFIX}/verification/callback`)
        .set('content-type', 'application/json')
        .set('x-signature', identityProvider.signPayload(ownerBody))
        .send(ownerBody)
        .expect(200);

      await register(`adm-shell-${seed}`);
      const shellToken = bearer(`adm-shell-${seed}`);
      const shellSession = await http()
        .post(`${PREFIX}/verification/session`)
        .set('authorization', shellToken)
        .send({ method: 'NFC_EID', purpose: 'ACCOUNT_RECOVERY' })
        .expect(201);
      const shellExternal = await pool.query<{ external_session_id: string }>(
        `SELECT external_session_id FROM verification_attempts WHERE id = $1`,
        [shellSession.body.attemptId],
      );
      const shellBody = JSON.stringify({
        externalSessionId: shellExternal.rows[0]?.external_session_id,
        outcome: 'VERIFIED',
        nationalId: `9${seed}`.padEnd(11, '0').slice(0, 11),
        assuranceLevel: 'HIGH',
      });
      const recovery = await http()
        .post(`${PREFIX}/verification/callback`)
        .set('content-type', 'application/json')
        .set('x-signature', identityProvider.signPayload(shellBody))
        .send(shellBody)
        .expect(200);
      expect(recovery.body.status).toBe('RECOVERY_PENDING_REVIEW');

      const row = await pool.query<{ target_user_id: string }>(
        `SELECT target_user_id FROM account_recovery_requests WHERE status = 'PENDING_REVIEW'`,
      );
      return { targetUserId: row.rows[0]?.target_user_id as string };
    }

    /**
     * R-36: operatör onayı bağımsız bir kontroldür.
     *
     * Faz 3 otomatik devri kaldırdı ama onaylayanın talebin tarafı olup olmadığı
     * kontrol edilmiyordu: ADMIN rolü elde eden bir saldırgan kendi kurtarma
     * talebini kendisi onaylayarak devralma yolunu geri getirebilirdi.
     */
    it('kurtarma talebini açan kişi ADMIN olsa bile kendi talebini onaylayamaz', async () => {
      await createPendingRequest('self1');

      const requester = await pool.query<{ id: string; requester_user_id: string }>(
        `SELECT id, requester_user_id FROM account_recovery_requests
          WHERE status = 'PENDING_REVIEW'`,
      );
      const requestId = requester.rows[0]!.id;
      // Saldırgan senaryosu: kabuk hesap ADMIN yetkisi kazanıyor.
      await grant(requester.rows[0]!.requester_user_id, 'ADMIN');

      await http()
        .post(`${PREFIX}/verification/recovery-requests/${requestId}/approve`)
        .set('authorization', bearer('adm-shell-self1'))
        .expect(403);

      // Talep kapanmaz: başka bir operatör hâlâ inceleyebilmeli.
      const after = await pool.query<{ status: string }>(
        `SELECT status FROM account_recovery_requests WHERE id = $1`,
        [requestId],
      );
      expect(after.rows[0]!.status).toBe('PENDING_REVIEW');

      // Oturum kimliği taşınmamış olmalı.
      const moved = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM auth_subjects
          WHERE provider_subject = 'adm-shell-self1' AND user_id = $1`,
        [requester.rows[0]!.requester_user_id],
      );
      expect(moved.rows[0]!.count).toBe('1');
    });

    it('hedef hesap ADMIN olsa bile kendi hesabına yapılan kurtarmayı onaylayamaz', async () => {
      const { targetUserId } = await createPendingRequest('self2');
      await grant(targetUserId, 'ADMIN');

      const row = await pool.query<{ id: string }>(
        `SELECT id FROM account_recovery_requests WHERE status = 'PENDING_REVIEW'`,
      );

      await http()
        .post(`${PREFIX}/verification/recovery-requests/${row.rows[0]!.id}/approve`)
        .set('authorization', bearer('adm-owner-self2'))
        .expect(403);
    });

    it('ADMIN kuyruğu görür ve onaylar; SUPPORT görür ama onaylayamaz', async () => {
      const { targetUserId } = await createPendingRequest('rec1');

      const adminId = await register('adm-recovery-admin');
      await grant(adminId, 'ADMIN');
      const supportId = await register('adm-recovery-support');
      await grant(supportId, 'SUPPORT');

      const supportList = await http()
        .get(`${PREFIX}/verification/recovery-requests`)
        .set('authorization', bearer('adm-recovery-support'))
        .expect(200);
      expect(supportList.body.items).toHaveLength(1);
      expect(supportList.body.items[0].targetUserId).toBe(targetUserId);

      await http()
        .post(`${PREFIX}/verification/recovery-requests/${supportList.body.items[0].id}/approve`)
        .set('authorization', bearer('adm-recovery-support'))
        .expect(403);

      const auditFrom = await currentAuditMaxId(pool);
      const approved = await http()
        .post(`${PREFIX}/verification/recovery-requests/${supportList.body.items[0].id}/approve`)
        .set('authorization', bearer('adm-recovery-admin'))
        .send({})
        .expect(200);
      expect(approved.body.status).toBe('APPROVED');
      expect(approved.body.recoveredUserId).toBe(targetUserId);
      expect(await auditActionsSince(pool, auditFrom)).toContain('ACCOUNT_RECOVERED');

      const closedQueue = await http()
        .get(`${PREFIX}/verification/recovery-requests`)
        .set('authorization', bearer('adm-recovery-admin'))
        .expect(200);
      expect(closedQueue.body.items).toHaveLength(0);
    });

    it('CUSTOMER kuyruğa erişemez', async () => {
      await register('adm-recovery-customer');
      await http()
        .get(`${PREFIX}/verification/recovery-requests`)
        .set('authorization', bearer('adm-recovery-customer'))
        .expect(403);
    });
  });

  // --- 2. Provider onay akışı ---

  describe('sağlayıcı onay akışı', () => {
    it('DRAFT -> PENDING_REVIEW -> APPROVED; SUPPORT karar veremez; atlama reddedilir', async () => {
      const providerId = await register('adm-prov-1');
      const providerToken = bearer('adm-prov-1');
      await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', providerToken)
        .send({ displayName: 'Test Sağlayıcı' })
        .expect(201);

      const adminId = await register('adm-prov-admin');
      await grant(adminId, 'ADMIN');
      const supportId = await register('adm-prov-support');
      await grant(supportId, 'SUPPORT');

      // Onaylamayı incelemeye girmeden denemek geçersiz geçiştir.
      await http()
        .post(`${PREFIX}/providers/${providerId}/approve`)
        .set('authorization', bearer('adm-prov-admin'))
        .expect(409);

      await http()
        .post(`${PREFIX}/providers/me/submit`)
        .set('authorization', providerToken)
        .expect(200);

      const supportQueue = await http()
        .get(`${PREFIX}/providers/queue`)
        .set('authorization', bearer('adm-prov-support'))
        .expect(200);
      expect(supportQueue.body.items.map((p: { userId: string }) => p.userId)).toContain(
        providerId,
      );

      await http()
        .post(`${PREFIX}/providers/${providerId}/approve`)
        .set('authorization', bearer('adm-prov-support'))
        .expect(403);

      const auditFrom = await currentAuditMaxId(pool);
      const approved = await http()
        .post(`${PREFIX}/providers/${providerId}/approve`)
        .set('authorization', bearer('adm-prov-admin'))
        .expect(200);
      expect(approved.body.state).toBe('APPROVED');
      expect(await auditActionsSince(pool, auditFrom)).toContain('PROVIDER_STATE_CHANGED');
    });

    it('askıya alma sağlayıcıyı eşleştirme adaylığından düşürür (matching yalnızca APPROVED okur)', async () => {
      const providerId = await register('adm-prov-2');
      await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', bearer('adm-prov-2'))
        .send({ displayName: 'Askıya Alınacak' })
        .expect(201);

      const adminId = await register('adm-prov-admin-2');
      await grant(adminId, 'ADMIN');

      await http()
        .post(`${PREFIX}/providers/me/submit`)
        .set('authorization', bearer('adm-prov-2'))
        .expect(200);
      await http()
        .post(`${PREFIX}/providers/${providerId}/approve`)
        .set('authorization', bearer('adm-prov-admin-2'))
        .expect(200);

      const suspended = await http()
        .post(`${PREFIX}/providers/${providerId}/suspend`)
        .set('authorization', bearer('adm-prov-admin-2'))
        .send({ reason: 'şikayet incelemesi' })
        .expect(200);
      expect(suspended.body.state).toBe('SUSPENDED');

      const state = await pool.query<{ state: string }>(
        `SELECT state FROM provider_profiles WHERE user_id = $1`,
        [providerId],
      );
      expect(state.rows[0]?.state).toBe('SUSPENDED');
    });
  });

  // --- 3-5. Booking / payment / dispute admin listeleme ---

  describe('rezervasyon / ödeme / uyuşmazlık admin listeleri', () => {
    it('ADMIN ve SUPPORT listeleri okuyabilir, CUSTOMER okuyamaz', async () => {
      const adminId = await register('adm-list-admin');
      await grant(adminId, 'ADMIN');
      const supportId = await register('adm-list-support');
      await grant(supportId, 'SUPPORT');
      await register('adm-list-customer');

      for (const [path, token] of [
        [`${PREFIX}/bookings/admin`, bearer('adm-list-admin')],
        [`${PREFIX}/bookings/admin`, bearer('adm-list-support')],
        [`${PREFIX}/payments/admin`, bearer('adm-list-admin')],
        [`${PREFIX}/disputes/admin`, bearer('adm-list-admin')],
      ] as const) {
        const response = await http().get(path).set('authorization', token).expect(200);
        expect(Array.isArray(response.body.items)).toBe(true);
      }

      await http()
        .get(`${PREFIX}/bookings/admin`)
        .set('authorization', bearer('adm-list-customer'))
        .expect(403);
    });

    it('sahiplik kapısı olmadan başkasının rezervasyonunu filtreyle bulabilir', async () => {
      const customerId = await register('adm-owner-cust');
      const customerToken = bearer('adm-owner-cust');
      const providerId = await register('adm-owner-prov');
      const providerToken = bearer('adm-owner-prov');
      const adminId = await register('adm-owner-admin');
      await grant(adminId, 'ADMIN');

      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', customerToken)
        .send({ displayName: 'Müşteri' })
        .expect(201);
      await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', providerToken)
        .send({ displayName: 'Sağlayıcı' })
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

      const filtered = await http()
        .get(`${PREFIX}/bookings/admin?customerId=${customerId}`)
        .set('authorization', bearer('adm-owner-admin'))
        .expect(200);
      expect(filtered.body.items.map((b: { id: string }) => b.id)).toContain(booking.body.id);

      const wrongFilter = await http()
        .get(`${PREFIX}/bookings/admin?providerId=${customerId}`)
        .set('authorization', bearer('adm-owner-admin'))
        .expect(200);
      expect(wrongFilter.body.items).toHaveLength(0);
    });
  });

  // --- 6. Safety: oturumdan bağımsız olay triyajı ---

  describe('güvenlik olayı triyajı', () => {
    it('ADMIN/SUPPORT boş listeyi okuyabilir, CUSTOMER okuyamaz', async () => {
      const adminId = await register('adm-safety-admin');
      await grant(adminId, 'ADMIN');
      const supportId = await register('adm-safety-support');
      await grant(supportId, 'SUPPORT');
      await register('adm-safety-customer');

      const asAdmin = await http()
        .get(`${PREFIX}/safety/operator/events`)
        .set('authorization', bearer('adm-safety-admin'))
        .expect(200);
      expect(asAdmin.body.items).toEqual([]);

      await http()
        .get(`${PREFIX}/safety/operator/events`)
        .set('authorization', bearer('adm-safety-support'))
        .expect(200);

      await http()
        .get(`${PREFIX}/safety/operator/events`)
        .set('authorization', bearer('adm-safety-customer'))
        .expect(403);
    });
  });

  // --- 7. Matching analitiği ---

  describe('eşleştirme analitiği özeti', () => {
    it('ADMIN/SUPPORT özet okur, CUSTOMER okuyamaz', async () => {
      const adminId = await register('adm-match-admin');
      await grant(adminId, 'ADMIN');
      await register('adm-match-customer');

      const stats = await http()
        .get(`${PREFIX}/matching/admin/stats`)
        .set('authorization', bearer('adm-match-admin'))
        .expect(200);
      expect(stats.body).toMatchObject({ totalRuns: 0, degradedRuns: 0, degradedRate: 0 });

      await http()
        .get(`${PREFIX}/matching/admin/stats`)
        .set('authorization', bearer('adm-match-customer'))
        .expect(403);
    });
  });

  // --- 8. Ops: sistem sağlığı, DLQ, bildirim işleri ---

  describe('ops: sistem sağlığı ve kuyruk yönetimi', () => {
    it('sağlık özeti ADMIN/SUPPORT tarafından okunabilir', async () => {
      const adminId = await register('adm-ops-admin');
      await grant(adminId, 'ADMIN');

      const health = await http()
        .get(`${PREFIX}/ops/health`)
        .set('authorization', bearer('adm-ops-admin'))
        .expect(200);
      expect(health.body).toHaveProperty('outbox');
      expect(health.body).toHaveProperty('deadLetter');
      expect(health.body).toHaveProperty('notificationJobs');
    });

    it('DLQ kaydını SUPPORT okuyabilir ama yalnızca ADMIN çözebilir; çözüm audit edilir', async () => {
      const adminId = await register('adm-dlq-admin');
      await grant(adminId, 'ADMIN');
      const supportId = await register('adm-dlq-support');
      await grant(supportId, 'SUPPORT');

      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO dead_letter_events
           (event_id, event_type, event_version, consumer, payload, attempt_count,
            failure_classification, failure_reason, first_failure_at, last_failure_at)
         VALUES (gen_random_uuid(), 'BookingCreated', 1, 'notification-job', '{}'::jsonb, 5,
                 'PERMANENT', 'şema uyuşmazlığı', now(), now())
         RETURNING id::text`,
      );
      const dlqId = inserted.rows[0]?.id as string;

      const list = await http()
        .get(`${PREFIX}/ops/dead-letter`)
        .set('authorization', bearer('adm-dlq-support'))
        .expect(200);
      expect(list.body.items.map((r: { id: string }) => r.id)).toContain(dlqId);

      await http()
        .post(`${PREFIX}/ops/dead-letter/${dlqId}/resolve`)
        .set('authorization', bearer('adm-dlq-support'))
        .expect(403);

      const auditFrom = await currentAuditMaxId(pool);
      await http()
        .post(`${PREFIX}/ops/dead-letter/${dlqId}/resolve`)
        .set('authorization', bearer('adm-dlq-admin'))
        .expect(200);
      expect(await auditActionsSince(pool, auditFrom)).toContain('DEAD_LETTER_EVENT_RESOLVED');

      // İkinci çözüm denemesi artık kayıt bulamaz.
      await http()
        .post(`${PREFIX}/ops/dead-letter/${dlqId}/resolve`)
        .set('authorization', bearer('adm-dlq-admin'))
        .expect(404);
    });

    it('bildirim işi yalnızca FAILED durumundayken yeniden kuyruklanabilir ve audit edilir', async () => {
      const adminId = await register('adm-notif-admin');
      await grant(adminId, 'ADMIN');
      const recipientId = await register('adm-notif-recipient');

      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO notification_jobs
           (event_id, event_type, channel, recipient_user_id, template_key, status, attempts, last_error)
         VALUES (gen_random_uuid(), 'BookingCreated', 'IN_APP', $1, 'booking.created', 'FAILED', 3, 'timeout')
         RETURNING id::text`,
        [recipientId],
      );
      const jobId = inserted.rows[0]?.id as string;

      const auditFrom = await currentAuditMaxId(pool);
      await http()
        .post(`${PREFIX}/ops/notification-jobs/${jobId}/retry`)
        .set('authorization', bearer('adm-notif-admin'))
        .expect(200);
      expect(await auditActionsSince(pool, auditFrom)).toContain('NOTIFICATION_JOB_RETRIED');

      const row = await pool.query<{ status: string; last_error: string | null }>(
        `SELECT status, last_error FROM notification_jobs WHERE id = $1`,
        [jobId],
      );
      expect(row.rows[0]).toEqual({ status: 'PENDING', last_error: null });

      // Zaten PENDING olan bir işi "retry" etmek anlamsızdır (yalnızca FAILED'dan çıkış vardır).
      await http()
        .post(`${PREFIX}/ops/notification-jobs/${jobId}/retry`)
        .set('authorization', bearer('adm-notif-admin'))
        .expect(404);
    });
  });
});
