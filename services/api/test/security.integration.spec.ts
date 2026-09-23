import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import type Redis from 'ioredis';
import { AuditVerificationService } from '../src/common/audit/audit-verification.service';
import { RetentionService } from '../src/common/retention/retention.service';
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
 * Faz 12 güvenlik sertleştirme davranışı.
 *
 * Zorunlu senaryolar: T-24 (retention gerçekten siliyor), T-36 (audit zinciri
 * kopukluğu tespit ediliyor), R-53 (başlık sahteciliğiyle oran sınırı atlatılamıyor),
 * ADR-0013 §4 (SUPPORT yıkıcı işlem yapamaz).
 */
describe('security hardening (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;

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

  /**
   * Test kullanıcısı + rol.
   *
   * Kayıt **gerçek akıştan** geçer (`POST /auth/session`): `auth_subjects` ve
   * `users` arasındaki tutarlılığı elle kurmak, testin kurgusunu doğrulamasına
   * yol açardı. Rol ataması doğrudan SQL'dir çünkü rol verme akışının kendisi
   * bu testin konusu değil, ön koşuludur.
   */
  async function createUser(subject: string, roles: string[]): Promise<string> {
    const response = await http()
      .post(`${PREFIX}/auth/session`)
      .set('authorization', bearer(subject))
      .expect(201);
    const userId = response.body.userId as string;

    for (const role of roles) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, role],
      );
    }
    return userId;
  }

  /** Zincire gerçek bir audit satırı ekler (trigger'ı atlamadan). */
  async function appendAudit(action: string, entityType = 'test'): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO audit_logs (action, entity_type) VALUES ($1, $2) RETURNING id`,
      [action, entityType],
    );
    return result.rows[0]!.id;
  }

  describe('audit hash zinciri doğrulaması (T-36)', () => {
    it('sağlam zincir OK döner ve checkpoint yazar', async () => {
      const service = app.get(AuditVerificationService);
      await appendAudit('USER_REGISTERED');
      await appendAudit('BOOKING_CREATED');

      const result = await service.verifyOnce();

      expect(result.status).toBe('OK');
      expect(result.brokenAtId).toBeNull();
      expect(result.rowsVerified).toBeGreaterThan(0);

      const checkpoint = await service.latestCheckpoint();
      expect(checkpoint?.status).toBe('OK');
    });

    // Artımlı doğrulama: ikinci tur yalnızca yeni satırları okur ama önceki
    // checkpoint'in hash'ini beklenen prev_hash olarak kullanır.
    it('ikinci tur yalnızca yeni satırları doğrular', async () => {
      const service = app.get(AuditVerificationService);
      await appendAudit('USER_REGISTERED');
      const first = await service.verifyOnce();

      await appendAudit('BOOKING_CREATED');
      const second = await service.verifyOnce();

      expect(second.status).toBe('OK');
      expect(second.rowsVerified).toBe(1);
      expect(Number(second.verifiedThroughId)).toBeGreaterThan(Number(first.verifiedThroughId));
    });

    it('yeni satır yokken tekrar tekrar checkpoint yazmaz', async () => {
      const service = app.get(AuditVerificationService);
      await appendAudit('USER_REGISTERED');
      await service.verifyOnce();

      const before = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_chain_checkpoints`,
      );
      await service.verifyOnce();
      const after = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_chain_checkpoints`,
      );

      expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    });

    /**
     * Zincir tamper-**evident**'tır: append-only trigger'ı düşürebilen ayrıcalıklı
     * bir erişim geçmişi yeniden yazabilir ama zincir kopar ve doğrulama bunu görür.
     *
     * Trigger'ın geri yüklenmesi `finally`'dedir: assert düşerse bile veritabanı
     * korumasız kalmamalı (Faz 2 review bulgusu).
     */
    it('değiştirilmiş audit satırı tespit edilir', async () => {
      const service = app.get(AuditVerificationService);
      await appendAudit('USER_REGISTERED');
      const targetId = await appendAudit('PAYMENT_STATUS_CHANGED', 'payment');
      await appendAudit('BOOKING_CREATED');

      await pool.query(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update`);
      try {
        // Saldırgan senaryosu: bir ödeme kaydının denetim izini sessizce değiştirmek.
        await pool.query(`UPDATE audit_logs SET action = 'USER_UPDATED' WHERE id = $1`, [targetId]);

        const result = await service.verifyOnce();

        expect(result.status).toBe('BROKEN');
        expect(result.brokenAtId).toBe(targetId);
      } finally {
        await pool.query(`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update`);
        await pool.query(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update`);
        await pool.query(`UPDATE audit_logs SET action = 'PAYMENT_STATUS_CHANGED' WHERE id = $1`, [
          targetId,
        ]);
        await pool.query(`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update`);
      }
    });

    it('kopukluk bulunduktan sonra doğrulama kendiliğinden ilerlemez', async () => {
      const service = app.get(AuditVerificationService);
      await appendAudit('USER_REGISTERED');
      const targetId = await appendAudit('PAYMENT_STATUS_CHANGED', 'payment');

      await pool.query(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update`);
      try {
        await pool.query(`UPDATE audit_logs SET action = 'USER_UPDATED' WHERE id = $1`, [targetId]);
        await service.verifyOnce();

        // Bozuk aralığı sessizce atlayıp "OK" demek, bulguyu kaybetmek olurdu.
        const again = await service.verifyOnce();
        expect(again.status).toBe('BROKEN');
      } finally {
        await pool.query(`UPDATE audit_logs SET action = 'PAYMENT_STATUS_CHANGED' WHERE id = $1`, [
          targetId,
        ]);
        await pool.query(`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update`);
      }
    });

    it('doğrulama hiçbir audit satırını değiştirmez', async () => {
      const service = app.get(AuditVerificationService);
      await appendAudit('USER_REGISTERED');

      const before = await pool.query<{ digest: string }>(
        `SELECT md5(string_agg(hash, '' ORDER BY id)) AS digest FROM audit_logs`,
      );
      await service.verifyOnce();
      const after = await pool.query<{ digest: string }>(
        `SELECT md5(string_agg(hash, '' ORDER BY id)) AS digest FROM audit_logs`,
      );

      expect(after.rows[0]!.digest).toBe(before.rows[0]!.digest);
    });

    it('checkpoint tablosu append-only kalır', async () => {
      const service = app.get(AuditVerificationService);
      await appendAudit('USER_REGISTERED');
      await service.verifyOnce();

      await expect(pool.query(`UPDATE audit_chain_checkpoints SET status = 'OK'`)).rejects.toThrow(
        /append-only/,
      );
      await expect(pool.query(`DELETE FROM audit_chain_checkpoints`)).rejects.toThrow(
        /append-only/,
      );
    });
  });

  describe('retention (T-24, R-38)', () => {
    it('süresi dolmuş kapatılmış hesabın kişisel verisi gerçekten kaldırılır', async () => {
      const retention = app.get(RetentionService);
      const userId = await createUser('retention-user', ['CUSTOMER']);

      await pool.query(
        `INSERT INTO customer_profiles (user_id, display_name) VALUES ($1, 'Ayşe Yılmaz')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO addresses (user_id, city, district, line, latitude, longitude)
         VALUES ($1, 'İstanbul', 'Kadıköy', 'Bahariye Cad. No:5 Daire 3', 40.99, 29.03)`,
        [userId],
      );
      // Kapatma anı saklama süresinden eski: retention işi bu hesabı toplamalı.
      await pool.query(
        `UPDATE users SET status = 'DELETED', email = NULL, phone = NULL,
                          deleted_at = now() - interval '400 days'
          WHERE id = $1`,
        [userId],
      );

      const result = await retention.sweep();

      expect(result.anonymizedUsers).toBe(1);

      const profile = await pool.query<{ display_name: string }>(
        `SELECT display_name FROM customer_profiles WHERE user_id = $1`,
        [userId],
      );
      expect(profile.rows[0]!.display_name).not.toContain('Ayşe');

      const address = await pool.query<{ line: string; latitude: number }>(
        `SELECT line, latitude FROM addresses WHERE user_id = $1`,
        [userId],
      );
      expect(address.rows[0]!.line).not.toContain('Bahariye');
      // Tam koordinat da kişiseldir: kaba bir değere yuvarlanır.
      expect(Number(address.rows[0]!.latitude)).not.toBeCloseTo(40.99, 2);

      const user = await pool.query<{ anonymized_at: Date | null }>(
        `SELECT anonymized_at FROM users WHERE id = $1`,
        [userId],
      );
      expect(user.rows[0]!.anonymized_at).not.toBeNull();
    });

    it('saklama süresi dolmamış kapatılmış hesaba dokunulmaz', async () => {
      const retention = app.get(RetentionService);
      const userId = await createUser('recent-deleted', ['CUSTOMER']);
      await pool.query(
        `INSERT INTO customer_profiles (user_id, display_name) VALUES ($1, 'Zeynep Kaya')`,
        [userId],
      );
      await pool.query(
        `UPDATE users SET status = 'DELETED', email = NULL, phone = NULL, deleted_at = now()
          WHERE id = $1`,
        [userId],
      );

      const result = await retention.sweep();

      expect(result.anonymizedUsers).toBe(0);
      const profile = await pool.query<{ display_name: string }>(
        `SELECT display_name FROM customer_profiles WHERE user_id = $1`,
        [userId],
      );
      expect(profile.rows[0]!.display_name).toBe('Zeynep Kaya');
    });

    it('aktif hesap hiçbir koşulda anonimleştirilmez', async () => {
      const retention = app.get(RetentionService);
      const userId = await createUser('active-user', ['CUSTOMER']);
      await pool.query(
        `INSERT INTO customer_profiles (user_id, display_name) VALUES ($1, 'Aktif Kullanıcı')`,
        [userId],
      );

      await retention.sweep();

      const profile = await pool.query<{ display_name: string }>(
        `SELECT display_name FROM customer_profiles WHERE user_id = $1`,
        [userId],
      );
      expect(profile.rows[0]!.display_name).toBe('Aktif Kullanıcı');
    });

    it('anonimleştirme audit izi bırakır ve tekrarlanmaz (idempotent)', async () => {
      const retention = app.get(RetentionService);
      const userId = await createUser('audited-delete', ['CUSTOMER']);
      await pool.query(
        `INSERT INTO customer_profiles (user_id, display_name) VALUES ($1, 'Silinecek')`,
        [userId],
      );
      await pool.query(
        `UPDATE users SET status = 'DELETED', email = NULL, phone = NULL,
                          deleted_at = now() - interval '400 days' WHERE id = $1`,
        [userId],
      );

      await retention.sweep();
      const second = await retention.sweep();

      expect(second.anonymizedUsers).toBe(0);
      const audits = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
          WHERE action = 'USER_ANONYMIZED' AND entity_id = $1`,
        [userId],
      );
      expect(audits.rows[0]!.count).toBe('1');
    });

    it('süresi dolmuş event tekilleştirme kayıtları silinir', async () => {
      const retention = app.get(RetentionService);
      await pool.query(
        `INSERT INTO processed_events (consumer, event_id, processed_at)
         VALUES ('test-consumer', gen_random_uuid(), now() - interval '400 days')`,
      );
      await pool.query(
        `INSERT INTO processed_events (consumer, event_id, processed_at)
         VALUES ('test-consumer', gen_random_uuid(), now())`,
      );

      const result = await retention.sweep();

      expect(result.processedEvents).toBe(1);
      const remaining = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM processed_events`,
      );
      expect(remaining.rows[0]!.count).toBe('1');
    });

    // Kanonik kopya BigQuery'dedir; oraya hiç ulaşmamış olayı silmek veriyi kaybetmektir.
    it('dışa aktarılmamış analytics event silinmez', async () => {
      const retention = app.get(RetentionService);
      await pool.query(
        `INSERT INTO analytics_events
           (event_id, event_type, aggregate_type, occurred_at, payload, created_at, exported_at)
         VALUES (gen_random_uuid(), 'booking.created', 'booking', now(), '{}'::jsonb,
                 now() - interval '400 days', NULL)`,
      );

      const result = await retention.sweep();

      expect(result.analyticsEvents).toBe(0);
    });
  });

  describe('oran sınırı ve başlık sahteciliği (R-53)', () => {
    /**
     * Varsayılan yapılandırmada (TRUSTED_PROXY_HOP_COUNT=0) `X-Forwarded-For`
     * okunmaz. Saldırgan her istekte farklı bir adres yazsa da aynı kovaya düşer.
     */
    it('X-Forwarded-For değiştirerek oran sınırı atlatılamaz', async () => {
      const limit = 10;
      let sawRateLimit = false;

      for (let attempt = 0; attempt < limit + 3; attempt += 1) {
        const response = await http()
          .post(`${PREFIX}/verification/session`)
          .set('x-forwarded-for', `203.0.113.${attempt}`)
          .send({ method: 'NFC' });

        if (response.status === 429) {
          sawRateLimit = true;
          break;
        }
      }

      expect(sawRateLimit).toBe(true);
    });
  });

  describe('ADMIN / SUPPORT ayrımı (ADR-0013 §4)', () => {
    it('SUPPORT audit zinciri durumunu okuyabilir', async () => {
      await createUser('support-reader', ['SUPPORT']);

      const response = await http()
        .get(`${PREFIX}/ops/audit-chain`)
        .set('authorization', bearer('support-reader'))
        .expect(200);

      expect(response.body).toHaveProperty('status');
    });

    it('SUPPORT doğrulamayı tetikleyemez', async () => {
      await createUser('support-verifier', ['SUPPORT']);

      await http()
        .post(`${PREFIX}/ops/audit-chain/verify`)
        .set('authorization', bearer('support-verifier'))
        .expect(403);
    });

    // Retention **veri siler**: yıkıcı işlem SUPPORT'a kapalıdır.
    it('SUPPORT retention taramasını tetikleyemez', async () => {
      await createUser('support-sweeper', ['SUPPORT']);

      await http()
        .post(`${PREFIX}/ops/retention/sweep`)
        .set('authorization', bearer('support-sweeper'))
        .expect(403);
    });

    it('ADMIN her iki işlemi de tetikleyebilir', async () => {
      await createUser('admin-ops', ['ADMIN']);

      await http()
        .post(`${PREFIX}/ops/audit-chain/verify`)
        .set('authorization', bearer('admin-ops'))
        .expect(200);
      await http()
        .post(`${PREFIX}/ops/retention/sweep`)
        .set('authorization', bearer('admin-ops'))
        .expect(200);
    });

    it('CUSTOMER ops uçlarını hiç göremez', async () => {
      await createUser('plain-customer', ['CUSTOMER']);

      await http()
        .get(`${PREFIX}/ops/audit-chain`)
        .set('authorization', bearer('plain-customer'))
        .expect(403);
    });
  });
});
