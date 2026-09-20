import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { IdentityService } from '../src/identity/identity.service';
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
 * Kimlik doğrulama akışı (ADR-0004, ADR-0005).
 *
 * Zorunlu senaryolar: T-01 (eşzamanlı mükerrer kimlik), T-01b (farklı sağlayıcıyla ikinci
 * hesap), T-01c (hash üretemeyen sağlayıcı), T-02 (recovery kötüye kullanımı),
 * T-03 (sağlayıcı erişilemez), callback replay reddi.
 */
describe('identity verification (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let provider: MockIdentityProvider;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    redis = createRedis();
    provider = app.get(MockIdentityProvider);
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);
    provider.setUnavailable(false);
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

  interface StartedSession {
    attemptId: string;
    externalSessionId: string;
  }

  async function startSession(
    subject: string,
    purpose: 'ACCOUNT_VERIFICATION' | 'ACCOUNT_RECOVERY' = 'ACCOUNT_VERIFICATION',
  ): Promise<StartedSession> {
    const response = await http()
      .post(`${PREFIX}/verification/session`)
      .set('authorization', bearer(subject))
      .send({ method: 'NFC_EID', purpose })
      .expect(201);

    const attemptId = response.body.attemptId as string;
    const external = await pool.query<{ external_session_id: string }>(
      `SELECT external_session_id FROM verification_attempts WHERE id = $1`,
      [attemptId],
    );

    return {
      attemptId,
      externalSessionId: external.rows[0]?.external_session_id as string,
    };
  }

  /** Sağlayıcının imzaladığı gibi ham gövde + imza gönderir. */
  async function sendCallback(
    payload: Record<string, unknown>,
    options: { signature?: string } = {},
  ): Promise<request.Response> {
    const rawBody = JSON.stringify(payload);
    const signature = options.signature ?? provider.signPayload(rawBody);

    return http()
      .post(`${PREFIX}/verification/callback`)
      .set('content-type', 'application/json')
      .set('x-signature', signature)
      .send(rawBody);
  }

  async function verifyIdentity(
    subject: string,
    nationalId: string,
    options: {
      assuranceLevel?: string;
      purpose?: 'ACCOUNT_VERIFICATION' | 'ACCOUNT_RECOVERY';
    } = {},
  ): Promise<request.Response> {
    const session = await startSession(subject, options.purpose ?? 'ACCOUNT_VERIFICATION');

    return sendCallback({
      externalSessionId: session.externalSessionId,
      outcome: 'VERIFIED',
      nationalId,
      assuranceLevel: options.assuranceLevel ?? 'HIGH',
    });
  }

  describe('doğrulama akışı', () => {
    it('oturum başlatır ve durumu raporlar', async () => {
      await register('id-sub-1');

      const started = await http()
        .post(`${PREFIX}/verification/session`)
        .set('authorization', bearer('id-sub-1'))
        .send({ method: 'NFC_EID' })
        .expect(201);

      expect(started.body.clientToken).toEqual(expect.any(String));
      expect(new Date(started.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const attempt = await http()
        .get(`${PREFIX}/verification/session/${started.body.attemptId}`)
        .set('authorization', bearer('id-sub-1'))
        .expect(200);

      expect(attempt.body.status).toBe('PENDING');
      expect(attempt.body.purpose).toBe('ACCOUNT_VERIFICATION');
    });

    it('desteklenmeyen yöntem reddedilir', async () => {
      await register('id-sub-2');

      const response = await http()
        .post(`${PREFIX}/verification/session`)
        .set('authorization', bearer('id-sub-2'))
        .send({ method: 'TELEPATHY' })
        .expect(400);

      expect(response.body.error.details.supportedMethods).toContain('NFC_EID');
    });

    it('callback doğrulamayı tamamlar ve seviyeyi yükseltir', async () => {
      await register('id-sub-3');
      const auditFrom = await currentAuditMaxId(pool);

      const callback = await verifyIdentity('id-sub-3', '12345678901');
      expect(callback.status).toBe(200);
      expect(callback.body.status).toBe('VERIFIED');

      const status = await http()
        .get(`${PREFIX}/verification/status`)
        .set('authorization', bearer('id-sub-3'))
        .expect(200);

      expect(status.body.level).toBe('IDENTITY_VERIFIED');
      expect(status.body.identityVerified).toBe(true);
      expect(status.body.assuranceLevel).toBe('HIGH');

      expect(await auditActionsSince(pool, auditFrom)).toEqual([
        'IDENTITY_VERIFICATION_STARTED',
        'IDENTITY_VERIFIED',
      ]);
    });

    it('IdentityVerified event.i outbox.a yazılır', async () => {
      await register('id-sub-4');
      await verifyIdentity('id-sub-4', '12345678902');

      const events = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM outbox WHERE event_type = 'IdentityVerified'`,
      );
      expect(events.rows).toHaveLength(1);
    });

    it('reddedilen doğrulama seviyeyi yükseltmez', async () => {
      await register('id-sub-5');
      const session = await startSession('id-sub-5');

      const response = await sendCallback({
        externalSessionId: session.externalSessionId,
        outcome: 'REJECTED',
        resultCode: 'DOCUMENT_MISMATCH',
      });
      expect(response.body.status).toBe('REJECTED');

      const status = await http()
        .get(`${PREFIX}/verification/status`)
        .set('authorization', bearer('id-sub-5'))
        .expect(200);
      expect(status.body.identityVerified).toBe(false);

      const attempt = await pool.query<{ status: string; result_code: string }>(
        `SELECT status, result_code FROM verification_attempts WHERE id = $1`,
        [session.attemptId],
      );
      expect(attempt.rows[0]?.status).toBe('REJECTED');
      expect(attempt.rows[0]?.result_code).toBe('DOCUMENT_MISMATCH');
    });
  });

  describe('callback güvenliği', () => {
    it('imzasız callback reddedilir', async () => {
      await register('id-sub-6');
      const session = await startSession('id-sub-6');

      await http()
        .post(`${PREFIX}/verification/callback`)
        .set('content-type', 'application/json')
        .send(JSON.stringify({ externalSessionId: session.externalSessionId, outcome: 'VERIFIED' }))
        .expect(422);
    });

    it('yanlış imzalı callback reddedilir ve nedeni sızdırmaz', async () => {
      await register('id-sub-7');
      const session = await startSession('id-sub-7');

      const response = await sendCallback(
        { externalSessionId: session.externalSessionId, outcome: 'VERIFIED', nationalId: '1' },
        { signature: 'f'.repeat(64) },
      );

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).not.toContain('signature');
    });

    it('gövde değiştirilmiş callback reddedilir (imza ham gövdeye bağlı)', async () => {
      await register('id-sub-8');
      const session = await startSession('id-sub-8');

      const original = JSON.stringify({
        externalSessionId: session.externalSessionId,
        outcome: 'REJECTED',
      });
      const signature = provider.signPayload(original);
      const tampered = JSON.stringify({
        externalSessionId: session.externalSessionId,
        outcome: 'VERIFIED',
        nationalId: '12345678903',
      });

      await http()
        .post(`${PREFIX}/verification/callback`)
        .set('content-type', 'application/json')
        .set('x-signature', signature)
        .send(tampered)
        .expect(422);
    });

    // Replay: sağlayıcı retry'ı veya kötü niyetli tekrar yeni yan etki üretmemeli.
    it('aynı callback ikinci kez işlenmez', async () => {
      await register('id-sub-9');
      const session = await startSession('id-sub-9');
      const payload = {
        externalSessionId: session.externalSessionId,
        outcome: 'VERIFIED',
        nationalId: '12345678904',
        assuranceLevel: 'HIGH',
      };

      const first = await sendCallback(payload);
      expect(first.body.status).toBe('VERIFIED');

      const auditFrom = await currentAuditMaxId(pool);
      const second = await sendCallback(payload);
      expect(second.status).toBe(200);

      // İkinci çağrı yeni audit kaydı veya yeni event üretmez.
      expect(await auditActionsSince(pool, auditFrom)).toEqual([]);
      const events = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM outbox WHERE event_type = 'IdentityVerified'`,
      );
      expect(events.rows[0]?.count).toBe('1');
    });

    it('bilinmeyen oturum için callback reddedilir', async () => {
      const response = await sendCallback({
        externalSessionId: 'mock-ses-yok',
        outcome: 'VERIFIED',
        nationalId: '12345678900',
      });

      expect(response.status).toBe(422);
    });
  });

  // T-01, T-01b: tekillik sağlayıcıdan bağımsız hash üzerinde, veritabanında zorlanır.
  describe('kimlik tekilliği', () => {
    it('aynı kimlik ikinci bir hesapta doğrulanamaz', async () => {
      await register('id-first');
      await verifyIdentity('id-first', '11111111111');

      await register('id-second');
      const response = await verifyIdentity('id-second', '11111111111');

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('IDENTITY_ALREADY_REGISTERED');

      const records = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM identity_records`,
      );
      expect(records.rows[0]?.count).toBe('1');
    });

    it('reddedilen ikinci deneme audit.e yazılır', async () => {
      await register('id-owner');
      await verifyIdentity('id-owner', '22222222222');

      await register('id-intruder');
      const auditFrom = await currentAuditMaxId(pool);
      await verifyIdentity('id-intruder', '22222222222');

      expect(await auditActionsSince(pool, auditFrom)).toEqual([
        'IDENTITY_VERIFICATION_STARTED',
        'IDENTITY_REJECTED',
      ]);
    });

    // T-01: eşzamanlı iki doğrulama tek kimlik kaydı üretmeli.
    it('eşzamanlı doğrulama tek kimlik kaydı üretir', async () => {
      await register('id-race-a');
      await register('id-race-b');

      const sessionA = await startSession('id-race-a');
      const sessionB = await startSession('id-race-b');

      const [first, second] = await Promise.all([
        sendCallback({
          externalSessionId: sessionA.externalSessionId,
          outcome: 'VERIFIED',
          nationalId: '33333333333',
          assuranceLevel: 'HIGH',
        }),
        sendCallback({
          externalSessionId: sessionB.externalSessionId,
          outcome: 'VERIFIED',
          nationalId: '33333333333',
          assuranceLevel: 'HIGH',
        }),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses[0]).toBe(200);
      // Kaybeden taraf ya uygulama kontrolüne ya da DB constraint'ine takılır;
      // her iki durumda da ikinci kayıt oluşmaz.
      expect([409, 422, 500]).toContain(statuses[1]);

      const records = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM identity_records`,
      );
      expect(records.rows[0]?.count).toBe('1');
    });

    // T-01b: sağlayıcı değiştirerek ikinci hesap açma yolu kapalı olmalı.
    it('farklı sağlayıcı subject.i aynı kimliği ikinci kez doğrulayamaz', async () => {
      await register('id-provider-a');
      await verifyIdentity('id-provider-a', '44444444444');

      // Aynı kimlik, farklı Emek kullanıcısı ve farklı sağlayıcı oturumu: tekillik
      // provider_subject_id'ye değil, sağlayıcıdan bağımsız identity_hash'e dayanır.
      await pool.query(`UPDATE identity_records SET verification_provider = 'other-provider'`);

      await register('id-provider-b');
      const response = await verifyIdentity('id-provider-b', '44444444444');

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('IDENTITY_ALREADY_REGISTERED');
    });
  });

  // T-02: hesap kurtarma bir devralma yoludur; kimlik eşleşmesi tek başına yetmez.
  describe('hesap kurtarma', () => {
    it('yüksek güvenceli kimlik eşleşmesi kurtarmayı OTOMATİK tamamlamaz', async () => {
      const ownerId = await register('id-recovery-owner');
      await verifyIdentity('id-recovery-owner', '55555555555');

      // Kullanıcı telefonunu kaybetti: yeni oturum kimliğiyle giriyor.
      const shellId = await register('id-recovery-new-device');
      expect(shellId).not.toBe(ownerId);

      const auditFrom = await currentAuditMaxId(pool);
      const response = await verifyIdentity('id-recovery-new-device', '55555555555', {
        purpose: 'ACCOUNT_RECOVERY',
        assuranceLevel: 'HIGH',
      });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('RECOVERY_PENDING_REVIEW');

      // Oturum kimliği HENÜZ taşınmadı: yeni cihaz kabuk hesabı görmeye devam eder.
      const me = await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('id-recovery-new-device'))
        .expect(200);
      expect(me.body.id).toBe(shellId);

      // Kanonik hesap sahibi erişimini kaybetmedi.
      await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('id-recovery-owner'))
        .expect(200);

      const requests = await pool.query<{ status: string; target_user_id: string }>(
        `SELECT status, target_user_id FROM account_recovery_requests`,
      );
      expect(requests.rows).toEqual([{ status: 'PENDING_REVIEW', target_user_id: ownerId }]);

      expect(await auditActionsSince(pool, auditFrom)).toEqual([
        'IDENTITY_VERIFICATION_STARTED',
        'ACCOUNT_RECOVERY_REQUESTED',
      ]);
    });

    /**
     * Devralma senaryosu: kurtarma oturumunu SALDIRGAN başlatır, bağlantıyı mağdura
     * ulaştırır ("kimliğinizi doğrulayın") ve mağdur kendi belgesiyle gerçek, yüksek
     * güvenceli bir doğrulama yapar. Güvence seviyesi belgeyi sunanı doğrular ama oturumu
     * başlatanı doğrulamaz — otomatik devir olsaydı saldırgan mağdurun hesabını alırdı.
     */
    it('saldırganın başlattığı oturum mağdurun hesabını devretmez', async () => {
      const victimId = await register('id-victim');
      await verifyIdentity('id-victim', '12121212121');

      const attackerId = await register('id-attacker');

      // Saldırgan kurtarma oturumu başlatır; mağdur kendi belgesiyle tamamlar.
      const response = await verifyIdentity('id-attacker', '12121212121', {
        purpose: 'ACCOUNT_RECOVERY',
        assuranceLevel: 'HIGH',
      });

      expect(response.body.status).toBe('RECOVERY_PENDING_REVIEW');

      // Saldırgan kendi kabuk hesabında kalır; mağdurun hesabı ve oturumu bozulmaz.
      const attackerView = await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('id-attacker'))
        .expect(200);
      expect(attackerView.body.id).toBe(attackerId);

      const victimView = await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('id-victim'))
        .expect(200);
      expect(victimView.body.id).toBe(victimId);

      const subjects = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM auth_subjects WHERE user_id = $1 AND status = 'ACTIVE'`,
        [victimId],
      );
      expect(subjects.rows[0]?.count).toBe('1');
    });

    it('operatör onayı oturum kimliğini taşır ve eski kimliği iptal eder', async () => {
      const ownerId = await register('id-approve-owner');
      await verifyIdentity('id-approve-owner', '88888888888');
      await register('id-approve-new');

      await verifyIdentity('id-approve-new', '88888888888', {
        purpose: 'ACCOUNT_RECOVERY',
        assuranceLevel: 'HIGH',
      });

      const requestId = (
        await pool.query<{ id: string }>(`SELECT id FROM account_recovery_requests`)
      ).rows[0]?.id as string;

      const auditFrom = await currentAuditMaxId(pool);
      // Operatör aksiyonu: admin API'si Faz 10'da bu servisi açacak.
      const result = await app
        .get(IdentityService)
        .approveRecovery({ requestId, actorUserId: ownerId, reason: 'belge incelendi' });

      expect(result.recoveredUserId).toBe(ownerId);

      // Yeni kimlik kanonik hesabı açar, eski kimlik iptal edilmiştir
      // (geri dönüştürülen telefon numarası riski).
      const me = await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('id-approve-new'))
        .expect(200);
      expect(me.body.id).toBe(ownerId);

      await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('id-approve-owner'))
        .expect(401);

      const subjects = await pool.query<{ provider_subject: string; status: string }>(
        `SELECT provider_subject, status FROM auth_subjects WHERE user_id = $1 ORDER BY status`,
        [ownerId],
      );
      expect(subjects.rows).toEqual([
        { provider_subject: 'id-approve-new', status: 'ACTIVE' },
        { provider_subject: 'id-approve-owner', status: 'REVOKED' },
      ]);

      expect(await auditActionsSince(pool, auditFrom)).toEqual(['ACCOUNT_RECOVERED']);
    });

    it('aynı talep ikinci kez onaylanamaz', async () => {
      const ownerId = await register('id-twice-owner');
      await verifyIdentity('id-twice-owner', '77771111222');
      await register('id-twice-new');
      await verifyIdentity('id-twice-new', '77771111222', {
        purpose: 'ACCOUNT_RECOVERY',
        assuranceLevel: 'HIGH',
      });

      const requestId = (
        await pool.query<{ id: string }>(`SELECT id FROM account_recovery_requests`)
      ).rows[0]?.id as string;

      const service = app.get(IdentityService);
      await service.approveRecovery({ requestId, actorUserId: ownerId });

      await expect(service.approveRecovery({ requestId, actorUserId: ownerId })).rejects.toThrow(
        /karara bağlanmış/,
      );
    });

    it('reddedilen talep oturum kimliğini taşımaz', async () => {
      const ownerId = await register('id-reject-owner');
      await verifyIdentity('id-reject-owner', '66661111222');
      const shellId = await register('id-reject-new');
      await verifyIdentity('id-reject-new', '66661111222', {
        purpose: 'ACCOUNT_RECOVERY',
        assuranceLevel: 'HIGH',
      });

      const requestId = (
        await pool.query<{ id: string }>(`SELECT id FROM account_recovery_requests`)
      ).rows[0]?.id as string;

      await app
        .get(IdentityService)
        .rejectRecovery({ requestId, actorUserId: ownerId, reason: 'belge eşleşmedi' });

      const me = await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('id-reject-new'))
        .expect(200);
      expect(me.body.id).toBe(shellId);

      const decided = await pool.query<{ status: string; decision_reason: string }>(
        `SELECT status, decision_reason FROM account_recovery_requests WHERE id = $1`,
        [requestId],
      );
      expect(decided.rows[0]?.status).toBe('REJECTED');
      expect(decided.rows[0]?.decision_reason).toBe('belge eşleşmedi');
    });

    it('düşük güvenceli kurtarma talebi hiç oluşmaz', async () => {
      await register('id-weak-owner');
      await verifyIdentity('id-weak-owner', '66666666666');

      await register('id-weak-attacker');
      const auditFrom = await currentAuditMaxId(pool);

      const response = await verifyIdentity('id-weak-attacker', '66666666666', {
        purpose: 'ACCOUNT_RECOVERY',
        assuranceLevel: 'SUBSTANTIAL',
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('RECOVERY_NOT_ALLOWED');
      expect(await auditActionsSince(pool, auditFrom)).toEqual([
        'IDENTITY_VERIFICATION_STARTED',
        'ACCOUNT_RECOVERY_REJECTED',
      ]);

      const requests = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM account_recovery_requests`,
      );
      expect(requests.rows[0]?.count).toBe('0');
    });

    // Kabuk hesabın verisi kapatılan hesapta asılı kalmamalı.
    it('kabuk hesabın kendi profili varsa talep oluşmaz', async () => {
      await register('id-shell-owner');
      await verifyIdentity('id-shell-owner', '99999999999');

      await register('id-shell-with-data');
      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', bearer('id-shell-with-data'))
        .send({ displayName: 'Kabuk Profil' })
        .expect(201);

      const response = await verifyIdentity('id-shell-with-data', '99999999999', {
        purpose: 'ACCOUNT_RECOVERY',
        assuranceLevel: 'HIGH',
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('RECOVERY_NOT_ALLOWED');

      const attempts = await pool.query<{ result_code: string }>(
        `SELECT result_code FROM verification_attempts ORDER BY created_at DESC LIMIT 1`,
      );
      expect(attempts.rows[0]?.result_code).toBe('RECOVERY_REQUIRES_REVIEW');
    });

    it('aynı hedef için ikinci bekleyen talep açılmaz', async () => {
      await register('id-flood-owner');
      await verifyIdentity('id-flood-owner', '10101010101');
      await register('id-flood-a');
      await register('id-flood-b');

      const first = await verifyIdentity('id-flood-a', '10101010101', {
        purpose: 'ACCOUNT_RECOVERY',
        assuranceLevel: 'HIGH',
      });
      expect(first.body.status).toBe('RECOVERY_PENDING_REVIEW');

      const second = await verifyIdentity('id-flood-b', '10101010101', {
        purpose: 'ACCOUNT_RECOVERY',
        assuranceLevel: 'HIGH',
      });
      expect(second.status).toBe(403);

      const requests = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM account_recovery_requests`,
      );
      expect(requests.rows[0]?.count).toBe('1');
    });

    it('kurtarma denemeleri oran sınırına tabidir', async () => {
      await register('id-flood');

      const results: number[] = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const response = await http()
          .post(`${PREFIX}/verification/session`)
          .set('authorization', bearer('id-flood'))
          .send({ method: 'NFC_EID', purpose: 'ACCOUNT_RECOVERY' });
        results.push(response.status);
      }

      // Kullanıcı bazlı sayaç (varsayılan 5) devreye girer.
      expect(results.filter((status) => status === 429).length).toBeGreaterThan(0);
    });
  });

  // T-03: sağlayıcı erişilemezken yarım kayıt oluşmamalı.
  describe('sağlayıcı arızası', () => {
    it('sağlayıcı erişilemezken oturum kaydı oluşmaz', async () => {
      await register('id-down');
      provider.setUnavailable(true);

      const response = await http()
        .post(`${PREFIX}/verification/session`)
        .set('authorization', bearer('id-down'))
        .send({ method: 'NFC_EID' })
        .expect(503);

      expect(response.body.error.code).toBe('SERVICE_DEGRADED');

      const attempts = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM verification_attempts`,
      );
      expect(attempts.rows[0]?.count).toBe('0');
    });

    it('sağlayıcı düzelince akış normal devam eder', async () => {
      await register('id-recover-provider');
      provider.setUnavailable(true);
      await http()
        .post(`${PREFIX}/verification/session`)
        .set('authorization', bearer('id-recover-provider'))
        .send({ method: 'NFC_EID' })
        .expect(503);

      provider.setUnavailable(false);
      const response = await verifyIdentity('id-recover-provider', '77777777777');

      expect(response.body.status).toBe('VERIFIED');
    });
  });

  describe('veri minimizasyonu', () => {
    // ADR-0004/0005: ham kimlik verisi hiçbir tabloda bulunmamalı.
    it('ham kimlik numarası hiçbir sütunda saklanmaz', async () => {
      await register('id-minimize');
      await verifyIdentity('id-minimize', '98765432109');

      const identity = await pool.query(
        `SELECT * FROM identity_records WHERE identity_hash IS NOT NULL`,
      );
      const attempts = await pool.query(`SELECT * FROM verification_attempts`);
      const audits = await pool.query(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 20`);
      const events = await pool.query(`SELECT * FROM outbox`);

      const serialized = JSON.stringify([identity.rows, attempts.rows, audits.rows, events.rows]);
      expect(serialized).not.toContain('98765432109');
    });

    it('kimlik hash.i API yanıtlarında dönmez', async () => {
      await register('id-hash-leak');
      await verifyIdentity('id-hash-leak', '13579246801');

      const status = await http()
        .get(`${PREFIX}/verification/status`)
        .set('authorization', bearer('id-hash-leak'))
        .expect(200);

      const hash = await pool.query<{ identity_hash: string }>(
        `SELECT identity_hash FROM identity_records LIMIT 1`,
      );
      expect(JSON.stringify(status.body)).not.toContain(hash.rows[0]?.identity_hash);
    });

    it('sağlayıcıya gönderilen referans Emek kullanıcı kimliğini içermez', async () => {
      const userId = await register('id-opaque');
      const session = await startSession('id-opaque');

      expect(session.externalSessionId).not.toContain(userId);
    });
  });

  describe('sahiplik', () => {
    it('başka kullanıcının doğrulama oturumu görüntülenemez', async () => {
      await register('id-owner-a');
      await register('id-owner-b');
      const session = await startSession('id-owner-a');

      await http()
        .get(`${PREFIX}/verification/session/${session.attemptId}`)
        .set('authorization', bearer('id-owner-b'))
        .expect(404);
    });

    it('kimlik doğrulaması olmadan oturum başlatılamaz', async () => {
      await http().post(`${PREFIX}/verification/session`).send({ method: 'NFC_EID' }).expect(401);
    });
  });
});
