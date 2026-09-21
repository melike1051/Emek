import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { UnitOfWork } from '../src/common/database/unit-of-work';
import {
  ANOMALY_CLIENT,
  type AnomalyClient,
  type AnomalyFeatures,
  type AnomalyOutcome,
} from '../src/safety/anomaly.port';
import { EMERGENCY_NOTIFIER, type EmergencyAlert } from '../src/safety/emergency-notifier.port';
import { HttpAnomalyClient } from '../src/safety/http-anomaly.client';
import { SafetyEvaluationService } from '../src/safety/safety-evaluation.service';
import { SafetyLifecycleService } from '../src/safety/safety-lifecycle.service';
import { SafetyMaintenanceService } from '../src/safety/safety-maintenance.service';
import { AWAY, FAR, HOME, IN_NEAR, OUT_NEAR, safetyFixtures } from './helpers/safety-fixtures';
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
 * Safety domaini (Faz 8 — ADR-0008, ADR-0019).
 *
 * Zorunlu senaryolar: T-20 (panik bağımlılıklar down iken), T-21 (geofence),
 * T-22 (anomali yanlış alarmı tek başına yükseltmez), T-23 (oturum dışı telemetri
 * reddi), T-24 (retention gerçekten siler), T-33 (sahte/replay/geri tarihli telemetri).
 *
 * Gerçek Postgres/PostGIS ve Redis kullanılır. Yalnızca **dış sınırlar** değiştirilir:
 * anomali istemcisi (varsayılanı: gerçek HTTP istemcisi, erişilemeyen bir adrese —
 * "AI servisi down" gerçek kod yolundan ölçülür) ve acil durum bildirimi.
 */
describe('safety (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;

  // --- Dış sınır stub'ları ---
  const unreachable = new HttpAnomalyClient(
    { env: { AI_SERVICE_URL: 'http://127.0.0.1:9', SAFETY_ANOMALY_TIMEOUT_MS: 300 } } as never,
    { warn: () => undefined, error: () => undefined } as never,
  );
  const anomaly = {
    calls: 0,
    impl: (features: AnomalyFeatures): Promise<AnomalyOutcome> => unreachable.assess(features),
    async assess(features: AnomalyFeatures): Promise<AnomalyOutcome> {
      this.calls += 1;
      return this.impl(features);
    },
  };
  const notifier = {
    alerts: [] as EmergencyAlert[],
    fail: false,
    async notify(alert: EmergencyAlert): Promise<void> {
      this.alerts.push(alert);
      if (this.fail) {
        throw new Error('bildirim kanalı kapalı');
      }
      await Promise.resolve();
    },
  };

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [
        { token: ANOMALY_CLIENT, value: anomaly satisfies AnomalyClient },
        { token: EMERGENCY_NOTIFIER, value: notifier },
      ],
    });
    pool = createPool();
    redis = createRedis();
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);
    anomaly.calls = 0;
    anomaly.impl = (features) => unreachable.assess(features);
    notifier.alerts = [];
    notifier.fail = false;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    redis?.disconnect();
  });

  const http = (): request.Agent => request(app.getHttpServer());

  const { register, grant, setup, advance, sessionOf, events, clock, batch, send } = safetyFixtures(
    () => app,
    () => pool,
  );

  // ------------------------------------------------------------------
  describe('oturum yaşam döngüsü', () => {
    it('rezervasyon onaylandı diye oturum açılmaz; ödeme sonrası SCHEDULED açar (telemetri kapalı)', async () => {
      const fixture = await setup('lifecycle', 'CONFIRMED');
      expect(await sessionOf(fixture.bookingId)).toBeUndefined();

      const auditBefore = await currentAuditMaxId(pool);
      await advance(fixture, 'SCHEDULED');

      const session = await sessionOf(fixture.bookingId);
      expect(session).toMatchObject({ status: 'PRE_SERVICE', risk_level: 'NORMAL' });
      expect(session.monitoring_started_at).toBeNull();
      expect(await auditActionsSince(pool, auditBefore)).toContain('SAFETY_SESSION_STARTED');
      expect((await events(session.id as string)).map((event) => event.event_type)).toEqual([
        'SESSION_STARTED',
      ]);
    });

    it('booking akışını izler: yola çıkış → izleme, check-in → aktif, check-out → kapalı', async () => {
      const fixture = await setup('follow', 'PROVIDER_ARRIVING');
      let session = await sessionOf(fixture.bookingId);
      expect(session.status).toBe('ARRIVAL_MONITORING');
      expect(session.monitoring_started_at).not.toBeNull();
      expect(session.next_evaluation_at).not.toBeNull();

      await advance(fixture, 'CHECKED_IN');
      session = await sessionOf(fixture.bookingId);
      expect(session.status).toBe('ACTIVE');
      expect(session.activation_geofence_state).toBe('UNKNOWN');

      await advance(fixture, 'CHECKED_OUT');
      session = await sessionOf(fixture.bookingId);
      expect(session).toMatchObject({ status: 'CLOSED', closure_reason: 'SERVICE_COMPLETED' });
      expect(session.next_evaluation_at).toBeNull();

      expect((await events(session.id as string)).map((event) => event.event_type)).toEqual([
        'SESSION_STARTED',
        'ARRIVAL_MONITORING_STARTED',
        'SESSION_ACTIVATED',
        'SESSION_CLOSED',
      ]);
    });

    it('iptal oturumu BOOKING_CANCELLED ile kapatır', async () => {
      const fixture = await setup('cancel', 'SCHEDULED');

      await http()
        .post(`${PREFIX}/bookings/${fixture.bookingId}/cancel`)
        .set('authorization', fixture.customerToken)
        .send({ reason: 'plan değişti' })
        .expect(201);

      expect(await sessionOf(fixture.bookingId)).toMatchObject({
        status: 'CLOSED',
        closure_reason: 'BOOKING_CANCELLED',
      });
    });

    it('eşzamanlı oturum açma denemelerinden yalnızca biri oturum oluşturur', async () => {
      const fixture = await setup('concurrent-open', 'CONFIRMED');
      const uow = app.get(UnitOfWork);
      const lifecycle = app.get(SafetyLifecycleService);

      await Promise.all(
        Array.from({ length: 5 }, () =>
          uow.withTransaction((client) =>
            lifecycle.onBookingTransition(client, {
              bookingId: fixture.bookingId,
              to: 'SCHEDULED',
            }),
          ),
        ),
      );

      const count = await pool.query(
        `SELECT count(*)::int AS n FROM safety_sessions WHERE booking_id = $1`,
        [fixture.bookingId],
      );
      expect(count.rows[0].n).toBe(1);
    });

    it('veritabanı aynı rezervasyon için ikinci açık oturumu reddeder', async () => {
      const fixture = await setup('unique', 'SCHEDULED');

      await expect(
        pool.query(
          `INSERT INTO safety_sessions (booking_id, provider_id, customer_id, service_location,
             geofence_radius_meters, geofence_accuracy_limit_meters, geofence_debounce_samples,
             telemetry_interval_seconds, telemetry_max_skew_seconds, telemetry_max_age_seconds,
             scheduled_start, scheduled_end, retention_expires_at)
           SELECT booking_id, provider_id, customer_id, service_location, 150, 100, 3, 30, 120, 900,
                  scheduled_start, scheduled_end, retention_expires_at
             FROM safety_sessions WHERE booking_id = $1`,
          [fixture.bookingId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('kapalı oturum geri açılamaz ve durum geri gidemez (veritabanı)', async () => {
      const fixture = await setup('forward', 'CHECKED_OUT');
      const session = await sessionOf(fixture.bookingId);

      await expect(
        pool.query(
          `UPDATE safety_sessions SET status = 'ACTIVE', closed_at = NULL, closure_reason = NULL WHERE id = $1`,
          [session.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('oturumu olmayan (Faz 8 öncesi) rezervasyon yola çıkınca oturum açılır ve adımlarla ilerler', async () => {
      const fixture = await setup('backfill', 'SCHEDULED');
      await pool.query(
        `TRUNCATE safety_risk_assessments, safety_events, location_events, safety_sessions`,
      );

      await advance(fixture, 'PROVIDER_ARRIVING');

      const session = await sessionOf(fixture.bookingId);
      expect(session.status).toBe('ARRIVAL_MONITORING');
      expect((await events(session.id as string)).map((event) => event.event_type)).toEqual([
        'SESSION_STARTED',
        'ARRIVAL_MONITORING_STARTED',
      ]);
    });

    it('taraf oturumu dar görünümle okur; üçüncü kişi ve başka sağlayıcı göremez', async () => {
      const fixture = await setup('view', 'PROVIDER_ARRIVING');

      const provider = await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}/safety-session`)
        .set('authorization', fixture.providerToken)
        .expect(200);
      expect(provider.body).toMatchObject({
        status: 'ARRIVAL_MONITORING',
        acceptsTelemetry: true,
        telemetryExpectedFromYou: true,
        telemetryIntervalSeconds: 30,
        emergencyActive: false,
      });
      // İç risk mantığı ve koordinat taraflara açılmaz.
      for (const hidden of [
        'riskLevel',
        'activeRules',
        'anomalyFlagged',
        'geofenceState',
        'latitude',
      ]) {
        expect(provider.body).not.toHaveProperty(hidden);
      }

      const customer = await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}/safety-session`)
        .set('authorization', fixture.customerToken)
        .expect(200);
      expect(customer.body.telemetryExpectedFromYou).toBe(false);

      const other = await setup('view-other', 'SCHEDULED');
      await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}/safety-session`)
        .set('authorization', other.providerToken)
        .expect(404);
      await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}/safety-session`)
        .set('authorization', fixture.strangerToken)
        .expect(404);
    });
  });

  // ------------------------------------------------------------------
  describe('telemetri', () => {
    it('oturum telemetri kabul etmiyorsa (PRE_SERVICE) reddedilir ve hiçbir şey saklanmaz (T-23)', async () => {
      const fixture = await setup('pre', 'SCHEDULED');
      const session = await sessionOf(fixture.bookingId);

      const response = await send(
        session.id as string,
        fixture.providerToken,
        batch(1, clock(), [{}]),
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SAFETY_SESSION_NOT_ACTIVE');
      const stored = await pool.query(`SELECT count(*)::int AS n FROM location_events`);
      expect(stored.rows[0].n).toBe(0);
    });

    it('geçerli paket kabul edilir; mesafe PostGIS ile sunucuda hesaplanır', async () => {
      const fixture = await setup('valid', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      // Örnekler arası 60 sn: 1,1 km'yi 60 sn'de katetmek fiziksel olarak mümkün.
      const next = clock(-170, 60);

      const response = await send(
        session.id as string,
        fixture.providerToken,
        batch(1, next, [AWAY, AWAY, { ...HOME }]),
      ).expect(200);

      expect(response.body).toMatchObject({
        accepted: 3,
        rejected: 0,
        telemetryIntervalSeconds: 30,
      });
      const rows = await pool.query(
        `SELECT sequence_number::int AS seq, distance_to_service_meters AS d, geofence_state
           FROM location_events WHERE session_id = $1 ORDER BY sequence_number`,
        [session.id],
      );
      expect(rows.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
      expect(rows.rows[0].d).toBeGreaterThan(1000);
      expect(rows.rows[0].d).toBeLessThan(1200);
      expect(rows.rows[2].d).toBe(0);

      const updated = await sessionOf(fixture.bookingId);
      expect(updated).toMatchObject({ telemetry_count: 3, last_sequence: '3', rejected_count: 0 });
      expect(updated.last_telemetry_at).not.toBeNull();
    });

    it('geçersiz koordinat, bilinmeyen alan ve aşırı büyük paket 400 alır', async () => {
      const fixture = await setup('invalid', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      const base = batch(1, clock(), [{}]);

      for (const sample of [
        { ...base.samples[0], latitude: 91 },
        { ...base.samples[0], longitude: -181 },
        { ...base.samples[0], accuracyMeters: -1 },
        { ...base.samples[0], sequence: 0 },
        { ...base.samples[0], capturedAt: 'dün' },
        // İstemci risk seviyesi ya da geofence sonucu **gönderemez**.
        { ...base.samples[0], riskLevel: 'NORMAL' },
        { ...base.samples[0], geofenceState: 'INSIDE' },
      ]) {
        const response = await send(session.id as string, fixture.providerToken, {
          samples: [sample],
        });
        expect(response.status).toBe(400);
      }

      const tooMany = batch(
        1,
        clock(),
        Array.from({ length: 21 }, () => ({})),
      );
      expect((await send(session.id as string, fixture.providerToken, tooMany)).status).toBe(400);
      expect(
        (await send(session.id as string, fixture.providerToken, { samples: [] })).status,
      ).toBe(400);
    });

    it('geleceğe tarihli ve bayat örnek reddedilir; yalnızca gelecek bütünlük ihlalidir (T-33)', async () => {
      const fixture = await setup('clock', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);

      const response = await send(
        session.id as string,
        fixture.providerToken,
        batch(1, clock(), [
          { capturedAt: new Date(Date.now() + 10 * 60 * 1000) },
          { capturedAt: new Date(Date.now() - 60 * 60 * 1000) },
        ]),
      ).expect(200);

      expect(response.body.results).toEqual([
        { sequence: 1, status: 'REJECTED', reason: 'CLOCK_SKEW_FUTURE' },
        { sequence: 2, status: 'REJECTED', reason: 'CLOCK_SKEW_STALE' },
      ]);
      expect(await sessionOf(fixture.bookingId)).toMatchObject({
        telemetry_count: 0,
        rejected_count: 2,
        integrity_rejection_count: 1,
      });
      const recorded = await events(session.id as string);
      expect(recorded.find((event) => event.event_type === 'TELEMETRY_REJECTED')?.details).toEqual({
        reasons: { CLOCK_SKEW_FUTURE: 1 },
      });
    });

    it('tekrar gönderilen paket (replay) durumu değiştirmez ve iki kez saklanmaz (T-33)', async () => {
      const fixture = await setup('replay', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      const body = batch(1, clock(), [{}, {}]);

      await send(session.id as string, fixture.providerToken, body).expect(200);
      const replay = await send(session.id as string, fixture.providerToken, body).expect(200);

      expect(replay.body.accepted).toBe(0);
      expect(
        replay.body.results.every(
          (result: { reason: string }) => result.reason === 'SEQUENCE_REPLAY',
        ),
      ).toBe(true);
      expect(await sessionOf(fixture.bookingId)).toMatchObject({
        telemetry_count: 2,
        rejected_count: 0,
        integrity_rejection_count: 0,
      });
      const stored = await pool.query(`SELECT count(*)::int AS n FROM location_events`);
      expect(stored.rows[0].n).toBe(2);
    });

    it('imkânsız hızdaki sıçrama reddedilir ve bütünlük olayı yazılır', async () => {
      const fixture = await setup('speed', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      const next = clock();

      const response = await send(
        session.id as string,
        fixture.providerToken,
        // 6 sn içinde ~55 km.
        batch(1, next, [{}, { latitude: HOME.latitude + 0.5 }]),
      ).expect(200);

      expect(response.body.results[1]).toEqual({
        sequence: 2,
        status: 'REJECTED',
        reason: 'IMPOSSIBLE_SPEED',
      });
      expect((await sessionOf(fixture.bookingId)).integrity_rejection_count).toBe(1);
    });

    it('zayıf doğruluk reddedilmez ama geofence kararına girmez', async () => {
      const fixture = await setup('accuracy', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);

      await send(
        session.id as string,
        fixture.providerToken,
        batch(1, clock(), [
          { ...AWAY, accuracyMeters: 800 },
          { ...AWAY, accuracyMeters: 800 },
          { ...AWAY, accuracyMeters: 800 },
          { ...AWAY, accuracyMeters: 800 },
        ]),
      ).expect(200);

      const rows = await pool.query(
        `SELECT DISTINCT geofence_state FROM location_events WHERE session_id = $1`,
        [session.id],
      );
      expect(rows.rows).toEqual([{ geofence_state: 'INSUFFICIENT_ACCURACY' }]);
      expect((await sessionOf(fixture.bookingId)).geofence_state).toBe('UNKNOWN');
    });

    it('müşteri, üçüncü kişi ve uydurma oturum kimliği telemetri gönderemez', async () => {
      const fixture = await setup('authz', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      const body = batch(1, clock(), [{}]);

      expect((await send(session.id as string, fixture.customerToken, body)).status).toBe(404);
      expect((await send(session.id as string, fixture.strangerToken, body)).status).toBe(404);
      expect(
        (await send('00000000-0000-4000-8000-000000000000', fixture.providerToken, body)).status,
      ).toBe(404);
      expect((await send(session.id as string, 'Bearer invalid', body)).status).toBe(401);
      expect(
        (await http().post(`${PREFIX}/safety/sessions/${session.id}/telemetry`).send(body)).status,
      ).toBe(401);

      expect((await sessionOf(fixture.bookingId)).telemetry_count).toBe(0);
    });

    it('kapalı oturuma telemetri reddedilir (T-23)', async () => {
      const fixture = await setup('closed', 'CHECKED_OUT');
      const session = await sessionOf(fixture.bookingId);

      const response = await send(
        session.id as string,
        fixture.providerToken,
        batch(1, clock(), [{}]),
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SAFETY_SESSION_ALREADY_CLOSED');
    });

    it('eşzamanlı paketler sıra numarasını bozmaz: her sıra en fazla bir kez saklanır', async () => {
      const fixture = await setup('parallel', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      const next = clock();
      const shared = batch(1, next, [{}, {}, {}, {}, {}]);

      const responses = await Promise.all(
        Array.from({ length: 4 }, () => send(session.id as string, fixture.providerToken, shared)),
      );

      expect(responses.every((response) => response.status === 200)).toBe(true);
      const accepted = responses.reduce(
        (sum, response) => sum + (response.body.accepted as number),
        0,
      );
      expect(accepted).toBe(5);
      const stored = await pool.query(
        `SELECT count(*)::int AS n, count(DISTINCT sequence_number)::int AS d FROM location_events`,
      );
      expect(stored.rows[0]).toEqual({ n: 5, d: 5 });
    });

    it('telemetri ucu oran sınırı uygular', async () => {
      const fixture = await setup('ratelimit', 'SCHEDULED');
      const statuses: number[] = [];
      for (let index = 0; index < 121; index += 1) {
        const response = await send(
          '00000000-0000-4000-8000-000000000000',
          fixture.providerToken,
          batch(1, clock(), [{}]),
        );
        statuses.push(response.status);
      }

      expect(statuses.slice(0, 120).every((status) => status === 404)).toBe(true);
      expect(statuses[120]).toBe(429);
    });
  });

  // ------------------------------------------------------------------
  describe('geofence (T-21)', () => {
    it('giriş ve çıkış debounce edilir; her kalıcı değişim tek olaydır', async () => {
      const fixture = await setup('geofence', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      const next = clock();

      // Dışarıdan yaklaş: ilk kesin durum OUTSIDE olayı yazmaz (yola çıkan dışarıdadır).
      await send(
        session.id as string,
        fixture.providerToken,
        batch(1, next, [FAR, FAR, FAR]),
      ).expect(200);
      expect((await sessionOf(fixture.bookingId)).geofence_state).toBe('OUTSIDE');
      // İçeri gir: iki gözlem yetmez, üçüncüde kabul edilir.
      await send(
        session.id as string,
        fixture.providerToken,
        batch(4, next, [IN_NEAR, IN_NEAR]),
      ).expect(200);
      expect((await sessionOf(fixture.bookingId)).geofence_state).toBe('OUTSIDE');
      await send(session.id as string, fixture.providerToken, batch(6, next, [IN_NEAR])).expect(
        200,
      );
      expect((await sessionOf(fixture.bookingId)).geofence_state).toBe('INSIDE');

      // Sınırda jitter (±100 m zıplama): olay yok.
      await send(
        session.id as string,
        fixture.providerToken,
        batch(7, next, [OUT_NEAR, IN_NEAR, OUT_NEAR, IN_NEAR, OUT_NEAR, IN_NEAR]),
      ).expect(200);
      expect((await sessionOf(fixture.bookingId)).geofence_state).toBe('INSIDE');

      // Kalıcı çıkış.
      await send(
        session.id as string,
        fixture.providerToken,
        batch(13, next, [OUT_NEAR, OUT_NEAR, OUT_NEAR]),
      ).expect(200);

      const geofenceEvents = (await events(session.id as string))
        .filter((event) => event.event_type.startsWith('GEOFENCE_'))
        .map((event) => event.event_type);
      expect(geofenceEvents).toEqual(['GEOFENCE_ENTERED', 'GEOFENCE_EXITED']);

      // Olay koordinat taşımaz.
      for (const event of await events(session.id as string)) {
        expect(event.details).not.toHaveProperty('latitude');
        expect(event.details).not.toHaveProperty('longitude');
      }
    });

    it('check-in anındaki geofence durumu kaydedilir', async () => {
      const fixture = await setup('checkin-geo', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      await send(
        session.id as string,
        fixture.providerToken,
        batch(1, clock(), [{}, {}, {}]),
      ).expect(200);

      await advance(fixture, 'CHECKED_IN');

      expect((await sessionOf(fixture.bookingId)).activation_geofence_state).toBe('INSIDE');
    });
  });

  // ------------------------------------------------------------------
  describe('risk değerlendirmesi', () => {
    const evaluation = (): SafetyEvaluationService => app.get(SafetyEvaluationService);

    it('anomali servisi erişilemezken kurallarla değerlendirir ve eksikliği kaydeder', async () => {
      const fixture = await setup('eval-down', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      await send(
        session.id as string,
        fixture.providerToken,
        batch(1, clock(), [AWAY, AWAY]),
      ).expect(200);

      const result = await evaluation().evaluate(session.id as string);

      expect(result.status).toBe('EVALUATED');
      expect(result.riskLevel).toBe('NORMAL');
      const assessment = await pool.query(
        `SELECT * FROM safety_risk_assessments WHERE session_id = $1`,
        [session.id],
      );
      expect(assessment.rows[0]).toMatchObject({
        anomaly_available: false,
        anomaly_unavailable_reason: 'TRANSPORT',
        ruleset_version: 'safety-rules-v2',
        aggregation_version: 'risk-agg-v1',
      });
      expect(assessment.rows[0].unavailable_signals).toEqual(
        expect.arrayContaining(['anomaly', 'route']),
      );
      // Değerlendirme kaydı koordinat taşımaz.
      expect(JSON.stringify(assessment.rows[0].signals)).not.toMatch(/latitude|longitude/);
    });

    it('telemetri kesilince yükselir, alarm üretir; akış dönünce düşer (escalation/de-escalation)', async () => {
      const fixture = await setup('eval-gap', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      const sessionId = session.id as string;
      await send(sessionId, fixture.providerToken, batch(1, clock(), [AWAY])).expect(200);
      const auditBefore = await currentAuditMaxId(pool);

      const silent = await evaluation().evaluate(sessionId, new Date(Date.now() + 40 * 60 * 1000));

      expect(silent.riskLevel).toBe('HIGH_RISK');
      expect(silent.findings.map((finding) => finding.ruleId)).toEqual(['SAFETY-R03']);
      expect(await auditActionsSince(pool, auditBefore)).toContain('SAFETY_RISK_CHANGED');
      const alerts = await pool.query(
        `SELECT payload FROM outbox WHERE event_type = 'SafetyAlertRaised'`,
      );
      expect(alerts.rows).toHaveLength(1);
      expect(alerts.rows[0].payload).toMatchObject({
        severity: 'HIGH_RISK',
        source: 'RULE_ENGINE',
      });

      // Aynı durum tekrar değerlendirilir: kural olayı tekrar yazılmaz.
      await evaluation().evaluate(sessionId, new Date(Date.now() + 41 * 60 * 1000));
      const ruleEvents = (await events(sessionId)).filter(
        (event) => event.event_type === 'RULE_TRIGGERED',
      );
      expect(ruleEvents).toHaveLength(1);

      const recovered = await evaluation().evaluate(sessionId);
      expect(recovered.riskLevel).toBe('NORMAL');
      const types = (await events(sessionId)).map((event) => event.event_type);
      expect(types).toEqual(expect.arrayContaining(['RISK_ESCALATED', 'RISK_DEESCALATED']));
    });

    it('anomali skoru tek başına yalnızca WARNING üretir; model sürümü kayda geçer (T-22)', async () => {
      const fixture = await setup('eval-ml', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      await send(session.id as string, fixture.providerToken, batch(1, clock(), [AWAY])).expect(
        200,
      );
      anomaly.impl = async () => ({
        status: 'ASSESSED',
        assessment: {
          anomalyScore: 0.97,
          modelVersion: 'anomaly-deviation-v1',
          quality: 1,
          contributions: [{ feature: 'moving_away', contribution: 0.7 }],
          unavailableFeatures: [],
          route: { etaSeconds: 300, distanceMeters: 1400, provider: 'haversine' },
        },
      });

      const result = await evaluation().evaluate(session.id as string);

      expect(result.riskLevel).toBe('WARNING');
      const flagged = await pool.query(
        `SELECT source, model_version, anomaly_score::float AS score, risk_level
           FROM safety_events WHERE session_id = $1 AND event_type = 'ANOMALY_FLAGGED'`,
        [session.id],
      );
      expect(flagged.rows[0]).toMatchObject({
        source: 'ML',
        model_version: 'anomaly-deviation-v1',
        score: 0.97,
        risk_level: 'WARNING',
      });
      const assessment = await pool.query(
        `SELECT anomaly_model_version, route_provider FROM safety_risk_assessments WHERE session_id = $1`,
        [session.id],
      );
      expect(assessment.rows[0]).toEqual({
        anomaly_model_version: 'anomaly-deviation-v1',
        route_provider: 'haversine',
      });
      // HIGH_RISK'e çıkmadığı için operatör alarm event'i yok.
      const alerts = await pool.query(
        `SELECT count(*)::int AS n FROM outbox WHERE event_type = 'SafetyAlertRaised'`,
      );
      expect(alerts.rows[0].n).toBe(0);
    });

    it('karar verilirken oturum kapanırsa sonuç atılır (değerlendirme ↔ check-out yarışı)', async () => {
      const fixture = await setup('eval-race', 'CHECKED_IN');
      const session = await sessionOf(fixture.bookingId);
      anomaly.impl = async () => {
        // Model yanıtı beklenirken sağlayıcı check-out yapar.
        await advance(fixture, 'CHECKED_OUT');
        return { status: 'UNAVAILABLE', reason: 'TIMEOUT' };
      };

      const result = await evaluation().evaluate(session.id as string);

      expect(result.status).toBe('DISCARDED_SESSION_NOT_ACTIVE');
      const count = await pool.query(`SELECT count(*)::int AS n FROM safety_risk_assessments`);
      expect(count.rows[0].n).toBe(0);
    });

    it('karar verilirken panik gelirse EMERGENCY korunur', async () => {
      const fixture = await setup('eval-panic', 'CHECKED_IN');
      const session = await sessionOf(fixture.bookingId);
      anomaly.impl = async () => {
        await http()
          .post(`${PREFIX}/safety/sessions/${session.id}/panic`)
          .set('authorization', fixture.providerToken)
          .send({})
          .expect(201);
        return { status: 'UNAVAILABLE', reason: 'TIMEOUT' };
      };

      const result = await evaluation().evaluate(session.id as string);

      expect(result.riskLevel).toBe('EMERGENCY');
      expect((await sessionOf(fixture.bookingId)).risk_level).toBe('EMERGENCY');
    });

    it('izleyici değerlendirmesi gelen oturumları sahiplenir ve değerlendirir', async () => {
      const fixture = await setup('eval-due', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);

      const results = await evaluation().evaluateDue();

      expect(results.map((result) => result.sessionId)).toEqual([session.id]);
      // Sahiplenme sonrası bir sonraki tur aynı oturumu hemen almaz.
      expect(await evaluation().evaluateDue()).toEqual([]);
    });
  });

  // ------------------------------------------------------------------
  describe('panik (T-20)', () => {
    function panic(sessionId: string, token: string, body: object = {}): request.Test {
      return http()
        .post(`${PREFIX}/safety/sessions/${sessionId}/panic`)
        .set('authorization', token)
        .send(body);
    }

    it('geçerli panik: kalıcı olay, EMERGENCY, rezervasyon askısı, outbox, audit, bildirim', async () => {
      const fixture = await setup('panic', 'CHECKED_IN');
      const session = await sessionOf(fixture.bookingId);
      const auditBefore = await currentAuditMaxId(pool);

      const response = await panic(session.id as string, fixture.providerToken, {
        category: 'THREAT',
      }).expect(201);

      expect(response.body).toMatchObject({ duplicate: false, bookingHoldApplied: true });
      expect(new Date(response.body.raisedAt as string).getTime()).toBeLessThanOrEqual(Date.now());

      const updated = await sessionOf(fixture.bookingId);
      expect(updated.risk_level).toBe('EMERGENCY');
      expect(updated.panic_raised_at).not.toBeNull();
      // Ham konum kanıt süresine uzatıldı.
      expect(new Date(updated.retention_expires_at as string).getTime()).toBeGreaterThan(
        Date.now() + 300 * 24 * 3600 * 1000,
      );

      const booking = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [
        fixture.bookingId,
      ]);
      expect(booking.rows[0].status).toBe('SAFETY_HOLD');

      const panicEvent = (await events(session.id as string)).find(
        (event) => event.event_type === 'PANIC_RAISED',
      );
      expect(panicEvent).toMatchObject({
        source: 'USER',
        details: {
          raisedBy: 'PROVIDER',
          category: 'THREAT',
          panicNumber: 1,
          bookingHoldApplied: true,
        },
      });
      expect(await auditActionsSince(pool, auditBefore)).toEqual(
        expect.arrayContaining(['SAFETY_PANIC_RAISED', 'BOOKING_STATUS_CHANGED']),
      );
      const outbox = await pool.query(
        `SELECT payload FROM outbox WHERE event_type = 'SafetyAlertRaised'`,
      );
      expect(outbox.rows[0].payload).toMatchObject({ severity: 'EMERGENCY', source: 'PANIC' });

      await new Promise((resolve) => setImmediate(resolve));
      expect(notifier.alerts).toHaveLength(1);
      // Panik yolu anomali modeline hiç gitmez.
      expect(anomaly.calls).toBe(0);
    });

    it('tekrar basış ve diğer tarafın basışı yan etki üretmez (idempotent)', async () => {
      const fixture = await setup('panic-dup', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);

      const first = await panic(session.id as string, fixture.providerToken).expect(201);
      const second = await panic(session.id as string, fixture.providerToken).expect(201);
      const customer = await panic(session.id as string, fixture.customerToken).expect(201);

      expect(second.body).toMatchObject({ duplicate: true, eventId: first.body.eventId });
      expect(customer.body.duplicate).toBe(true);
      const count = await pool.query(
        `SELECT count(*)::int AS n FROM safety_events WHERE event_type = 'PANIC_RAISED'`,
      );
      expect(count.rows[0].n).toBe(1);
      const outbox = await pool.query(
        `SELECT count(*)::int AS n FROM outbox WHERE event_type = 'SafetyAlertRaised'`,
      );
      expect(outbox.rows[0].n).toBe(1);
    });

    it('eşzamanlı panik istekleri tek olay üretir', async () => {
      const fixture = await setup('panic-parallel', 'CHECKED_IN');
      const session = await sessionOf(fixture.bookingId);

      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          panic(
            session.id as string,
            index % 2 === 0 ? fixture.providerToken : fixture.customerToken,
          ),
        ),
      );

      expect(responses.every((response) => response.status === 201)).toBe(true);
      expect(responses.filter((response) => response.body.duplicate === false)).toHaveLength(1);
      const count = await pool.query(
        `SELECT count(*)::int AS n FROM safety_events WHERE event_type = 'PANIC_RAISED'`,
      );
      expect(count.rows[0].n).toBe(1);
    });

    it('yetkisiz panik: üçüncü kişi 404, kimliksiz 401; hiçbir şey yazılmaz', async () => {
      const fixture = await setup('panic-authz', 'CHECKED_IN');
      const session = await sessionOf(fixture.bookingId);

      expect((await panic(session.id as string, fixture.strangerToken)).status).toBe(404);
      expect(
        (await http().post(`${PREFIX}/safety/sessions/${session.id}/panic`).send({})).status,
      ).toBe(401);
      expect(
        (await panic('00000000-0000-4000-8000-000000000000', fixture.providerToken)).status,
      ).toBe(404);
      expect((await sessionOf(fixture.bookingId)).panic_raised_at).toBeNull();
    });

    it('kapalı oturumda panik reddedilir', async () => {
      const fixture = await setup('panic-closed', 'CHECKED_OUT');
      const session = await sessionOf(fixture.bookingId);

      const response = await panic(session.id as string, fixture.providerToken);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SAFETY_SESSION_ALREADY_CLOSED');
    });

    it('bozuk istek 400 alır', async () => {
      const fixture = await setup('panic-malformed', 'CHECKED_IN');
      const session = await sessionOf(fixture.bookingId);

      expect(
        (await panic(session.id as string, fixture.providerToken, { category: 'FIRE' })).status,
      ).toBe(400);
      expect(
        (await panic(session.id as string, fixture.providerToken, { riskLevel: 'NORMAL' })).status,
      ).toBe(400);
      expect((await panic('not-a-uuid', fixture.providerToken)).status).toBe(400);
    });

    it('kalıcı kayıttan sonra bildirim başarısız olsa da panik kaydedilir', async () => {
      const fixture = await setup('panic-notify', 'CHECKED_IN');
      const session = await sessionOf(fixture.bookingId);
      notifier.fail = true;

      await panic(session.id as string, fixture.providerToken).expect(201);
      await new Promise((resolve) => setImmediate(resolve));

      expect(notifier.alerts).toHaveLength(1);
      expect((await sessionOf(fixture.bookingId)).risk_level).toBe('EMERGENCY');
    });

    it('varış sırasındaki (PRE_SERVICE/ARRIVAL) panik de rezervasyonu askıya alır', async () => {
      const fixture = await setup('panic-pre', 'SCHEDULED');
      const session = await sessionOf(fixture.bookingId);

      const response = await panic(session.id as string, fixture.customerToken).expect(201);

      expect(response.body.bookingHoldApplied).toBe(true);
      const booking = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [
        fixture.bookingId,
      ]);
      expect(booking.rows[0].status).toBe('SAFETY_HOLD');
    });

    it('operatör acil durumu çözdükten sonra yeni panik kabul edilir; EMERGENCY otomatik düşmez', async () => {
      const fixture = await setup('panic-rearm', 'CHECKED_IN');
      const session = await sessionOf(fixture.bookingId);
      const adminId = await register('sf-admin-rearm');
      await grant(adminId, 'ADMIN');
      const admin = bearer('sf-admin-rearm');

      await panic(session.id as string, fixture.providerToken).expect(201);
      // Kurallar sussa bile EMERGENCY kendiliğinden düşmez.
      await app.get(SafetyEvaluationService).evaluate(session.id as string);
      expect((await sessionOf(fixture.bookingId)).risk_level).toBe('EMERGENCY');

      await http()
        .post(`${PREFIX}/safety/operator/sessions/${session.id}/risk`)
        .set('authorization', admin)
        .send({ riskLevel: 'NORMAL', reason: 'yanlış alarm, müşteriyle görüşüldü' })
        .expect(200);
      expect((await sessionOf(fixture.bookingId)).emergency_resolved_at).not.toBeNull();

      const second = await panic(session.id as string, fixture.providerToken).expect(201);
      expect(second.body.duplicate).toBe(false);
      const numbers = (await events(session.id as string))
        .filter((event) => event.event_type === 'PANIC_RAISED')
        .map((event) => event.details.panicNumber);
      expect(numbers).toEqual([1, 2]);
    });

    it('check-out ile yarışta tutarlı kalır: ya panik askıya alır ya da oturum kapanmıştır', async () => {
      const fixture = await setup('panic-race', 'IN_PROGRESS');
      const session = await sessionOf(fixture.bookingId);

      const [panicResponse, checkout] = await Promise.all([
        panic(session.id as string, fixture.providerToken),
        http()
          .post(`${PREFIX}/bookings/${fixture.bookingId}/transitions`)
          .set('authorization', fixture.providerToken)
          .send({ to: 'CHECKED_OUT' }),
      ]);

      expect([201, 409]).toContain(panicResponse.status);
      expect([201, 409]).toContain(checkout.status);
      const booking = (
        await pool.query(`SELECT status FROM bookings WHERE id = $1`, [fixture.bookingId])
      ).rows[0].status as string;
      const updated = await sessionOf(fixture.bookingId);
      if (panicResponse.status === 201) {
        expect(booking).toBe('SAFETY_HOLD');
        expect(updated.status).not.toBe('CLOSED');
        expect(checkout.status).toBe(409);
      } else {
        expect(booking).toBe('CHECKED_OUT');
        expect(updated.status).toBe('CLOSED');
      }
    });
  });

  // ------------------------------------------------------------------
  describe('operatör ve RBAC', () => {
    it('SUPPORT açık oturumları okur ama değiştiremez; taraflar operatör uçlarına erişemez', async () => {
      const fixture = await setup('operator', 'CHECKED_IN');
      const session = await sessionOf(fixture.bookingId);
      const supportId = await register('sf-support');
      await grant(supportId, 'SUPPORT');
      const support = bearer('sf-support');

      const list = await http()
        .get(`${PREFIX}/safety/operator/sessions?minRisk=NORMAL`)
        .set('authorization', support)
        .expect(200);
      expect(list.body.map((item: { sessionId: string }) => item.sessionId)).toContain(session.id);
      expect(list.body[0]).not.toHaveProperty('latitude');

      await http()
        .get(`${PREFIX}/safety/operator/sessions/${session.id}`)
        .set('authorization', support)
        .expect(200);
      await http()
        .get(`${PREFIX}/safety/operator/sessions/${session.id}/locations`)
        .set('authorization', support)
        .expect(403);
      await http()
        .post(`${PREFIX}/safety/operator/sessions/${session.id}/risk`)
        .set('authorization', support)
        .send({ riskLevel: 'NORMAL', reason: 'deneme amaçlı' })
        .expect(403);

      for (const token of [fixture.providerToken, fixture.customerToken]) {
        await http()
          .get(`${PREFIX}/safety/operator/sessions`)
          .set('authorization', token)
          .expect(403);
      }
    });

    it("ham iz yalnızca ADMIN'e açıktır ve her okuma audit'lenir", async () => {
      const fixture = await setup('locations', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      await send(session.id as string, fixture.providerToken, batch(1, clock(), [{}, {}])).expect(
        200,
      );
      const adminId = await register('sf-admin-loc');
      await grant(adminId, 'ADMIN');
      const auditBefore = await currentAuditMaxId(pool);

      const response = await http()
        .get(`${PREFIX}/safety/operator/sessions/${session.id}/locations?limit=10`)
        .set('authorization', bearer('sf-admin-loc'))
        .expect(200);

      expect(response.body.locations).toHaveLength(2);
      expect(await auditActionsSince(pool, auditBefore)).toEqual(['SAFETY_LOCATION_ACCESSED']);
    });

    it("risk kararı gerekçe ister ve audit'lenir; operatör kapatması OPERATOR kaynaklıdır", async () => {
      const fixture = await setup('override', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      const adminId = await register('sf-admin-ovr');
      await grant(adminId, 'ADMIN');
      const admin = bearer('sf-admin-ovr');

      await http()
        .post(`${PREFIX}/safety/operator/sessions/${session.id}/risk`)
        .set('authorization', admin)
        .send({ riskLevel: 'HIGH_RISK' })
        .expect(400);

      const auditBefore = await currentAuditMaxId(pool);
      await http()
        .post(`${PREFIX}/safety/operator/sessions/${session.id}/risk`)
        .set('authorization', admin)
        .send({ riskLevel: 'HIGH_RISK', reason: 'müşteri telefonla endişe bildirdi' })
        .expect(200);
      expect(await auditActionsSince(pool, auditBefore)).toEqual(['SAFETY_RISK_OVERRIDDEN']);

      const closed = await http()
        .post(`${PREFIX}/safety/operator/sessions/${session.id}/close`)
        .set('authorization', admin)
        .expect(200);
      expect(closed.body).toMatchObject({ status: 'CLOSED', closureReason: 'OPERATOR_CLOSED' });
      const closing = (await events(session.id as string)).find(
        (event) => event.event_type === 'SESSION_CLOSED',
      );
      expect(closing?.source).toBe('OPERATOR');

      await http()
        .post(`${PREFIX}/safety/operator/sessions/${session.id}/close`)
        .set('authorization', admin)
        .expect(409);
    });
  });

  // ------------------------------------------------------------------
  describe('retention ve süre aşımı (T-24)', () => {
    it('saklama süresi dolan kapalı oturumun ham izi silinir; olaylar ve özet kalır', async () => {
      const fixture = await setup('retention', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      await send(
        session.id as string,
        fixture.providerToken,
        batch(1, clock(), [OUT_NEAR, IN_NEAR, {}]),
      ).expect(200);
      await advance(fixture, 'CHECKED_OUT');
      await pool.query(
        `UPDATE safety_sessions SET retention_expires_at = now() - interval '1 day' WHERE id = $1`,
        [session.id],
      );
      const eventCount = (await events(session.id as string)).length;
      const auditBefore = await currentAuditMaxId(pool);

      const result = await app.get(SafetyMaintenanceService).purgeExpiredLocations();

      expect(result).toEqual({ sessions: 1, rows: 3 });
      const remaining = await pool.query(`SELECT count(*)::int AS n FROM location_events`);
      expect(remaining.rows[0].n).toBe(0);
      const purged = await pool.query(
        `SELECT last_latitude, last_longitude, location_purged_at, telemetry_count,
                ST_Y(service_location::geometry) AS lat
           FROM safety_sessions WHERE id = $1`,
        [session.id],
      );
      expect(purged.rows[0]).toMatchObject({
        last_latitude: null,
        last_longitude: null,
        telemetry_count: 3,
      });
      expect(purged.rows[0].location_purged_at).not.toBeNull();
      // Hizmet noktası ~1 km'ye yuvarlandı.
      expect(purged.rows[0].lat).toBeCloseTo(40.99, 5);
      expect((await events(session.id as string)).length).toBe(eventCount);
      expect(await auditActionsSince(pool, auditBefore)).toEqual(['SAFETY_LOCATION_PURGED']);

      // İkinci tur aynı oturuma dokunmaz.
      expect(await app.get(SafetyMaintenanceService).purgeExpiredLocations()).toEqual({
        sessions: 0,
        rows: 0,
      });
    });

    it('açık oturumun ham izi silinmez', async () => {
      const fixture = await setup('retention-open', 'PROVIDER_ARRIVING');
      const session = await sessionOf(fixture.bookingId);
      await send(session.id as string, fixture.providerToken, batch(1, clock(), [{}])).expect(200);
      await pool.query(
        `UPDATE safety_sessions SET retention_expires_at = now() - interval '1 day' WHERE id = $1`,
        [session.id],
      );

      expect(await app.get(SafetyMaintenanceService).purgeExpiredLocations()).toEqual({
        sessions: 0,
        rows: 0,
      });
    });

    it('süresi dolan düşük riskli oturum EXPIRED ile kapanır; yüksek riskli kapanmaz', async () => {
      const low = await setup('expire-low', 'PROVIDER_ARRIVING');
      const high = await setup('expire-high', 'PROVIDER_ARRIVING');
      for (const fixture of [low, high]) {
        await pool.query(
          `UPDATE safety_sessions
              SET scheduled_start = now() - interval '20 hours',
                  scheduled_end = now() - interval '13 hours'
            WHERE booking_id = $1`,
          [fixture.bookingId],
        );
      }
      await pool.query(
        `UPDATE safety_sessions SET risk_level = 'HIGH_RISK' WHERE booking_id = $1`,
        [high.bookingId],
      );

      const result = await app.get(SafetyMaintenanceService).runMaintenance();

      expect(result.expiredSessions).toBe(1);
      expect(await sessionOf(low.bookingId)).toMatchObject({
        status: 'CLOSED',
        closure_reason: 'EXPIRED',
      });
      expect((await sessionOf(high.bookingId)).status).toBe('ARRIVAL_MONITORING');
      expect(
        result.partitions.every((name) => name === null || name.startsWith('location_events_')),
      ).toBe(true);
    });

    it('güvenlik olayları ve değerlendirmeler değiştirilemez', async () => {
      const fixture = await setup('immutable', 'SCHEDULED');
      const session = await sessionOf(fixture.bookingId);

      await expect(
        pool.query(`UPDATE safety_events SET risk_level = 'NORMAL' WHERE session_id = $1`, [
          session.id,
        ]),
      ).rejects.toMatchObject({ code: '23001' });
      await expect(
        pool.query(`DELETE FROM safety_events WHERE session_id = $1`, [session.id]),
      ).rejects.toMatchObject({ code: '23001' });
    });
  });
});
