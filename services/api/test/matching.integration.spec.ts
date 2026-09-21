import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import request from 'supertest';
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
 * Eşleştirme akışı (Faz 7 — ADR-0007, ADR-0012).
 *
 * Bu paket, karar motoruna **ulaşılamadığı** koşulda çalışır: `AI_SERVICE_URL`
 * yönlendirilemez bir adrese (TEST-NET-1) ayarlanır. Ölçülen şey tam olarak budur —
 * core'un kendi aday havuzu, kendi kısıt değerlendirmesi ve kendi deterministik
 * yedek sıralaması. Motorun kendi kararları AI servisinin kendi test paketinde
 * ölçülür; burada bir mock koymak, core'un gerçek bozulma yolunu ölçmemek olurdu.
 *
 * Zorunlu senaryolar: T-17 (determinizm), T-18 (hard constraint ihlali skorla
 * telafi edilemez), T-19 (açıklama kişisel veri sızdırmaz), T-16 (bozulma işaretli).
 */
describe('matching (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;

  interface Fixture {
    customerToken: string;
    customerId: string;
    addressId: string;
    serviceId: string;
    requestId: string;
    window: { start: string; end: string };
  }

  beforeAll(async () => {
    app = await createTestApp({
      // Yönlendirilemez adres (RFC 5737 TEST-NET-1): bağlantı kurulamaz.
      env: { AI_SERVICE_URL: 'http://192.0.2.1:9', MATCHING_SERVICE_TIMEOUT_MS: '300' },
    });
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

  /** Yarının 08:00-20:00 UTC aralığı: tüm test pencereleri bunun içinde kalır. */
  function tomorrow(hour: number): Date {
    const moment = new Date();
    moment.setUTCDate(moment.getUTCDate() + 1);
    moment.setUTCHours(hour, 0, 0, 0);
    return moment;
  }

  async function serviceIdBySlug(slug: string): Promise<string> {
    const result = await pool.query<{ id: string }>(`SELECT id FROM services WHERE slug = $1`, [
      slug,
    ]);
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error(`hizmet bulunamadı: ${slug}`);
    }
    return id;
  }

  async function skillIdBySlug(slug: string): Promise<string> {
    const result = await pool.query<{ id: string }>(`SELECT id FROM skills WHERE slug = $1`, [
      slug,
    ]);
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error(`yetkinlik bulunamadı: ${slug}`);
    }
    return id;
  }

  /**
   * Doğrulanmış bir sağlayıcı kurar.
   *
   * Sağlayıcı onayı (`APPROVED`) ve kimlik doğrulaması operasyon/kimlik akışlarına
   * aittir; burada doğrudan SQL ile kurulur çünkü ölçülen şey eşleştirmedir,
   * onay akışı değil.
   */
  interface ProviderOptions {
    skills?: { slug: string; level: 'BEGINNER' | 'INTERMEDIATE' | 'EXPERT'; verified?: boolean }[];
    serviceSlugs?: string[];
    availability?: { start: Date; end: Date }[];
    areaRadiusMeters?: number;
    areaLatitude?: number;
    areaLongitude?: number;
    approved?: boolean;
    identityVerified?: boolean;
    maxDailyBookings?: number;
    ratingAvg?: number;
    ratingCount?: number;
  }

  async function setupProvider(seed: string, options: ProviderOptions = {}): Promise<string> {
    const providerId = await register(`mt-provider-${seed}`);
    const token = bearer(`mt-provider-${seed}`);

    await http()
      .post(`${PREFIX}/providers/profile`)
      .set('authorization', token)
      .send({ displayName: `Sağlayıcı ${seed}` })
      .expect(201);

    await pool.query(
      `UPDATE provider_profiles
          SET state = $2::provider_state,
              max_daily_bookings = $3,
              rating_avg = $4,
              rating_count = $5
        WHERE user_id = $1`,
      [
        providerId,
        options.approved === false ? 'PENDING_REVIEW' : 'APPROVED',
        options.maxDailyBookings ?? 2,
        options.ratingCount === 0 ? null : (options.ratingAvg ?? 4.6),
        options.ratingCount ?? 20,
      ],
    );

    if (options.identityVerified !== false) {
      await pool.query(
        `INSERT INTO identity_records
           (user_id, verification_provider, provider_subject_id, identity_hash,
            hash_key_version, verification_level, verification_status, assurance_level, verified_at)
         VALUES ($1, 'mock', $2, $3, 'v1', 'PROVIDER_VERIFIED', 'VERIFIED', 'HIGH', now())`,
        [providerId, `subject-${seed}`, seed.padEnd(64, '0').slice(0, 64)],
      );
    }

    for (const slug of options.serviceSlugs ?? ['detayli-temizlik']) {
      await http()
        .post(`${PREFIX}/providers/me/services`)
        .set('authorization', token)
        .send({ serviceId: await serviceIdBySlug(slug) })
        .expect(201);
    }

    for (const skill of options.skills ?? [{ slug: 'derin-temizlik', level: 'EXPERT' }]) {
      const skillId = await skillIdBySlug(skill.slug);
      await http()
        .post(`${PREFIX}/providers/me/skills`)
        .set('authorization', token)
        .send({ skillId, level: skill.level })
        .expect(201);

      if (skill.verified !== false) {
        await pool.query(
          `UPDATE provider_skills SET verified = TRUE WHERE provider_id = $1 AND skill_id = $2`,
          [providerId, skillId],
        );
      }
    }

    await http()
      .post(`${PREFIX}/providers/me/service-areas`)
      .set('authorization', token)
      .send({
        name: `Bölge ${seed}`,
        latitude: options.areaLatitude ?? 40.9909,
        longitude: options.areaLongitude ?? 29.0303,
        radiusMeters: options.areaRadiusMeters ?? 10_000,
      })
      .expect(201);

    for (const window of options.availability ?? [{ start: tomorrow(6), end: tomorrow(20) }]) {
      await http()
        .post(`${PREFIX}/providers/me/availability`)
        .set('authorization', token)
        .send({ startsAt: window.start.toISOString(), endsAt: window.end.toISOString() })
        .expect(201);
    }

    return providerId;
  }

  async function setupRequest(
    seed: string,
    options: { durationMinutes?: number; startHour?: number; endHour?: number } = {},
  ): Promise<Fixture> {
    const customerId = await register(`mt-customer-${seed}`);
    const customerToken = bearer(`mt-customer-${seed}`);

    await http()
      .post(`${PREFIX}/customers/profile`)
      .set('authorization', customerToken)
      .send({ displayName: `Müşteri ${seed}` })
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

    const serviceId = await serviceIdBySlug('detayli-temizlik');
    const start = tomorrow(options.startHour ?? 8);
    const end = tomorrow(options.endHour ?? 18);

    const created = await http()
      .post(`${PREFIX}/booking-requests`)
      .set('authorization', customerToken)
      .send({
        serviceId,
        addressId: address.body.id,
        preferredStart: start.toISOString(),
        preferredEnd: end.toISOString(),
        durationMinutes: options.durationMinutes ?? 180,
      })
      .expect(201);

    return {
      customerToken,
      customerId,
      addressId: address.body.id as string,
      serviceId,
      requestId: created.body.id as string,
      window: { start: start.toISOString(), end: end.toISOString() },
    };
  }

  function match(fixture: Fixture): request.Test {
    return http()
      .post(`${PREFIX}/booking-requests/${fixture.requestId}/match`)
      .set('authorization', fixture.customerToken);
  }

  describe('aday havuzu ve hard constraint.ler', () => {
    it('uygun sağlayıcıyı atar, rezervasyon oluşturur ve talebi MATCHED yapar', async () => {
      const providerId = await setupProvider('happy');
      const fixture = await setupRequest('happy');

      const response = await match(fixture).expect(201);

      expect(response.body.status).toBe('MATCHED');
      expect(response.body.providerId).toBe(providerId);
      expect(response.body.bookingId).not.toBeNull();

      const booking = await pool.query<{ status: string; request_id: string | null }>(
        `SELECT status::text AS status, request_id FROM bookings WHERE id = $1`,
        [response.body.bookingId],
      );
      // Eşleştirme durum makinesinden geçer: REQUESTED → MATCHED → PROVIDER_PENDING.
      expect(booking.rows[0]?.status).toBe('PROVIDER_PENDING');
      // Rezervasyon talebe bağlanır; bağ olmadan "hangi kararla oluştu" yanıtsız kalır.
      expect(booking.rows[0]?.request_id).toBe(fixture.requestId);

      const requestRow = await pool.query<{ status: string }>(
        `SELECT status::text AS status FROM booking_requests WHERE id = $1`,
        [fixture.requestId],
      );
      expect(requestRow.rows[0]?.status).toBe('MATCHED');
    });

    it('durum geçişleri geçmişe yazılır', async () => {
      await setupProvider('history');
      const fixture = await setupRequest('history');

      const response = await match(fixture).expect(201);

      const history = await pool.query<{ to_status: string }>(
        `SELECT to_status::text AS to_status FROM booking_status_history
          WHERE booking_id = $1 ORDER BY id`,
        [response.body.bookingId],
      );

      expect(history.rows.map((row) => row.to_status)).toEqual([
        'REQUESTED',
        'MATCHED',
        'PROVIDER_PENDING',
      ]);
    });

    it('uygun sağlayıcı yoksa rezervasyon oluşturmaz ama karar kaydı yazar', async () => {
      const fixture = await setupRequest('empty');

      const response = await match(fixture).expect(201);

      expect(response.body.status).toBe('NO_CANDIDATE');
      expect(response.body.bookingId).toBeNull();
      expect(response.body.runId).toEqual(expect.any(String));

      const runs = await pool.query<{ candidate_count: number; eligible_count: number }>(
        `SELECT candidate_count, eligible_count FROM matching_runs WHERE request_id = $1`,
        [fixture.requestId],
      );
      expect(runs.rows[0]?.candidate_count).toBe(0);
      expect(runs.rows[0]?.eligible_count).toBe(0);
    });

    it('doğrulanmamış sağlayıcı aday olmaz (T-18)', async () => {
      await setupProvider('unverified', { identityVerified: false });
      const fixture = await setupRequest('unverified');

      const response = await match(fixture).expect(201);

      expect(response.body.status).toBe('NO_CANDIDATE');
      // Doğrulama elemesi **LIMIT'ten önce** yapılır: doğrulanmamış sağlayıcı havuza
      // hiç girmez. Aksi hâlde "en yakın N" bütçesi atanamayacak adaylara harcanır ve
      // biraz daha uzaktaki uygun sağlayıcı hiç değerlendirilmezdi.
      const run = await pool.query<{ candidate_count: number; eligible_count: number }>(
        `SELECT candidate_count, eligible_count FROM matching_runs WHERE request_id = $1`,
        [fixture.requestId],
      );
      expect(run.rows[0]?.candidate_count).toBe(0);
      expect(run.rows[0]?.eligible_count).toBe(0);
    });

    it('yetkinlik elemesi kısıt katmanında ölçülebilir kalır', async () => {
      // Yetkinlik bilinçli olarak SQL.de filtrelenmez: talebe göre değişir ve
      // `eligible_count` sinyalini taşıyan tek kısıt odur.
      await setupProvider('skillgap', {
        skills: [{ slug: 'utu', level: 'EXPERT' }],
      });
      const fixture = await setupRequest('skillgap');
      await pool.query(
        `UPDATE booking_requests
            SET structured_request = $2::jsonb, parser_version = 'heuristic-v1',
                parser_confidence = 0.95
          WHERE id = $1`,
        [
          fixture.requestId,
          JSON.stringify({ service_type: 'detayli-temizlik', requirements: ['derin-temizlik'] }),
        ],
      );

      const response = await match(fixture).expect(201);
      const run = await pool.query<{ candidate_count: number; eligible_count: number }>(
        `SELECT candidate_count, eligible_count FROM matching_runs WHERE request_id = $1`,
        [fixture.requestId],
      );

      expect(response.body.status).toBe('NO_CANDIDATE');
      expect(run.rows[0]?.candidate_count).toBe(1);
      expect(run.rows[0]?.eligible_count).toBe(0);
    });

    it('onaylanmamış sağlayıcı aday olmaz', async () => {
      await setupProvider('pending', { approved: false });
      const fixture = await setupRequest('pending');

      await expect(match(fixture).expect(201)).resolves.toMatchObject({
        body: { status: 'NO_CANDIDATE' },
      });
    });

    it('hizmeti sunmayan sağlayıcı havuza hiç girmez', async () => {
      await setupProvider('other-service', { serviceSlugs: ['yasli-bakimi'] });
      const fixture = await setupRequest('other-service');

      const response = await match(fixture).expect(201);
      const run = await pool.query<{ candidate_count: number }>(
        `SELECT candidate_count FROM matching_runs WHERE request_id = $1`,
        [fixture.requestId],
      );

      expect(response.body.status).toBe('NO_CANDIDATE');
      // Havuz hizmetten başlar: sorgu bu sağlayıcıyı hiç getirmez.
      expect(run.rows[0]?.candidate_count).toBe(0);
    });

    it('coğrafi sınır dışındaki sağlayıcı havuza girmez', async () => {
      // Bölge merkezi ~100 km uzakta ve yarıçapı 5 km: adres kapsama alanında değil.
      await setupProvider('far', {
        areaLatitude: 41.9,
        areaLongitude: 29.0303,
        areaRadiusMeters: 5_000,
      });
      const fixture = await setupRequest('far');

      const run = await match(fixture).expect(201);
      expect(run.body.status).toBe('NO_CANDIDATE');
    });

    it('müsait olmayan sağlayıcı elenir', async () => {
      await setupProvider('busy', {
        // Müsaitlik talep penceresinin tamamen dışında.
        availability: [{ start: tomorrow(20), end: tomorrow(23) }],
      });
      const fixture = await setupRequest('busy');

      await expect(match(fixture).expect(201)).resolves.toMatchObject({
        body: { status: 'NO_CANDIDATE' },
      });
    });

    it('müsaitliği süreye yetmeyen sağlayıcı elenir', async () => {
      await setupProvider('short', {
        availability: [{ start: tomorrow(8), end: tomorrow(10) }],
      });
      const fixture = await setupRequest('short', { durationMinutes: 180 });

      await expect(match(fixture).expect(201)).resolves.toMatchObject({
        body: { status: 'NO_CANDIDATE' },
      });
    });

    it('zorunlu yetkinliği doğrulanmamış sağlayıcı elenir', async () => {
      await setupProvider('unskilled', {
        skills: [{ slug: 'derin-temizlik', level: 'EXPERT', verified: false }],
      });
      const fixture = await setupRequest('unskilled');
      // Form yolunda zorunlu yetkinlik yoktur; talebe NLP çıktısı eklenir.
      await pool.query(
        `UPDATE booking_requests
            SET structured_request = $2::jsonb, parser_version = 'heuristic-v1',
                parser_confidence = 0.9
          WHERE id = $1`,
        [
          fixture.requestId,
          JSON.stringify({ service_type: 'detayli-temizlik', requirements: ['derin-temizlik'] }),
        ],
      );

      await expect(match(fixture).expect(201)).resolves.toMatchObject({
        body: { status: 'NO_CANDIDATE' },
      });
    });

    it('mevcut rezervasyon müsaitlikten düşülür ama sağlayıcıyı tamamen elemez', async () => {
      const providerId = await setupProvider('partial');
      const blocker = await setupRequest('partial-blocker');

      // Sabahı dolduran bir rezervasyon: öğleden sonrası hâlâ müsait.
      await pool.query(
        `INSERT INTO bookings
           (customer_id, provider_id, service_id, address_id, scheduled_start, scheduled_end,
            price_minor, status)
         VALUES ($1, $2, $3, $4, $5, $6, 100000, 'CONFIRMED')`,
        [
          blocker.customerId,
          providerId,
          blocker.serviceId,
          blocker.addressId,
          tomorrow(8),
          tomorrow(12),
        ],
      );

      const fixture = await setupRequest('partial');
      const response = await match(fixture).expect(201);

      expect(response.body.status).toBe('MATCHED');
      // Atama sabahki rezervasyondan sonra başlamalı.
      expect(new Date(response.body.scheduledStart).getTime()).toBeGreaterThanOrEqual(
        tomorrow(12).getTime(),
      );
    });

    it('günlük kapasitesi dolmuş sağlayıcı elenir', async () => {
      const providerId = await setupProvider('capacity', { maxDailyBookings: 1 });
      const blocker = await setupRequest('capacity-blocker');

      await pool.query(
        `INSERT INTO bookings
           (customer_id, provider_id, service_id, address_id, scheduled_start, scheduled_end,
            price_minor, status)
         VALUES ($1, $2, $3, $4, $5, $6, 100000, 'CONFIRMED')`,
        [
          blocker.customerId,
          providerId,
          blocker.serviceId,
          blocker.addressId,
          tomorrow(6),
          tomorrow(7),
        ],
      );

      const fixture = await setupRequest('capacity');
      await expect(match(fixture).expect(201)).resolves.toMatchObject({
        body: { status: 'NO_CANDIDATE' },
      });
    });
  });

  describe('sıralama ve karar kaydı', () => {
    it('birden fazla aday sıralanır ve hepsi karar kaydına yazılır', async () => {
      const near = await setupProvider('near', { areaRadiusMeters: 3_000 });
      await setupProvider('mid', {
        areaLatitude: 41.02,
        areaLongitude: 29.06,
        areaRadiusMeters: 10_000,
      });
      const fixture = await setupRequest('multi');

      const response = await match(fixture).expect(201);

      const results = await pool.query<{ provider_id: string; rank: number; selected: boolean }>(
        `SELECT r.provider_id, r.rank, r.selected
           FROM booking_match_results r
          WHERE r.request_id = $1
          ORDER BY r.rank`,
        [fixture.requestId],
      );

      expect(results.rows).toHaveLength(2);
      expect(results.rows.map((row) => row.rank)).toEqual([1, 2]);
      // Yedek sıralama mesafeye göredir: adresin üstündeki bölge merkezi en yakındır.
      expect(results.rows[0]?.provider_id).toBe(near);
      expect(results.rows.filter((row) => row.selected)).toHaveLength(1);
      expect(response.body.providerId).toBe(near);
    });

    it('karar kaydı sürüm ve skor bileşenlerini saklar (ADR-0012 §1)', async () => {
      await setupProvider('versioned');
      const fixture = await setupRequest('versioned');

      await match(fixture).expect(201);

      const run = await pool.query<{
        algorithm_version: string;
        weights_version: string;
        objective_version: string;
        strategy: string;
        degraded_reason: string | null;
      }>(
        `SELECT algorithm_version, weights_version, objective_version,
                strategy::text AS strategy, degraded_reason::text AS degraded_reason
           FROM matching_runs WHERE request_id = $1`,
        [fixture.requestId],
      );

      expect(run.rows[0]?.algorithm_version).toBe('fallback-distance-v1');
      expect(run.rows[0]?.strategy).toBe('RANKED_FALLBACK');
      expect(run.rows[0]?.degraded_reason).toBe('ENGINE_UNAVAILABLE');

      const result = await pool.query<Record<string, string>>(
        `SELECT skill_score, availability_score, quality_score, distance_score,
                rating_score, preference_score, overall_score, algorithm_version
           FROM booking_match_results WHERE request_id = $1`,
        [fixture.requestId],
      );
      const row = result.rows[0];
      expect(row).toBeDefined();
      for (const column of [
        'skill_score',
        'availability_score',
        'quality_score',
        'distance_score',
        'rating_score',
        'preference_score',
        'overall_score',
      ]) {
        expect(Number(row?.[column])).toBeGreaterThanOrEqual(0);
        expect(Number(row?.[column])).toBeLessThanOrEqual(1);
      }
    });

    it('karar kaydı değiştirilemez (append-only)', async () => {
      await setupProvider('immutable');
      const fixture = await setupRequest('immutable');
      await match(fixture).expect(201);

      await expect(
        pool.query(`UPDATE booking_match_results SET selected = FALSE WHERE request_id = $1`, [
          fixture.requestId,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it('aynı çalıştırmada birden fazla aday seçili olamaz', async () => {
      await setupProvider('single-selected');
      const fixture = await setupRequest('single-selected');
      await match(fixture).expect(201);

      const run = await pool.query<{ id: string }>(
        `SELECT id FROM matching_runs WHERE request_id = $1`,
        [fixture.requestId],
      );

      await expect(
        pool.query(
          `INSERT INTO booking_match_results
             (run_id, request_id, provider_id, rank, skill_score, availability_score,
              quality_score, distance_score, rating_score, preference_score, overall_score,
              algorithm_version, selected, distance_meters, travel_seconds,
              proposed_start, proposed_end)
           SELECT $1, request_id, provider_id, 99, 0, 0, 0, 0, 0, 0, 0,
                  'x', TRUE, 0, 0, now(), now() + interval '1 hour'
             FROM booking_match_results WHERE run_id = $1 LIMIT 1`,
          [run.rows[0]?.id],
        ),
      ).rejects.toThrow();
    });

    it('aynı girdi aynı sıralamayı üretir (T-17)', async () => {
      await setupProvider('det-a', { areaRadiusMeters: 4_000 });
      await setupProvider('det-b', {
        areaLatitude: 41.01,
        areaLongitude: 29.05,
        areaRadiusMeters: 8_000,
      });

      const first = await setupRequest('det-1');
      const second = await setupRequest('det-2');

      await match(first).expect(201);
      await match(second).expect(201);

      const ranking = async (requestId: string): Promise<string[]> => {
        const rows = await pool.query<{ provider_id: string }>(
          `SELECT provider_id FROM booking_match_results WHERE request_id = $1 ORDER BY rank`,
          [requestId],
        );
        return rows.rows.map((row) => row.provider_id);
      };

      expect(await ranking(first.requestId)).toEqual(await ranking(second.requestId));
    });

    it('audit ve outbox kayıtları yazılır', async () => {
      await setupProvider('audited');
      const fixture = await setupRequest('audited');
      const sinceId = await currentAuditMaxId(pool);

      const response = await match(fixture).expect(201);

      const actions = await auditActionsSince(pool, sinceId);
      expect(actions).toEqual(
        expect.arrayContaining(['MATCHING_RUN_COMPLETED', 'BOOKING_MATCHED']),
      );

      const events = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM outbox WHERE subject_id = $1`,
        [response.body.bookingId],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual(
        expect.arrayContaining(['BookingCreated', 'BookingMatched']),
      );
    });
  });

  describe('bozulma ve tekrar', () => {
    it('karar motoru erişilemezken sonuç degraded işaretlenir (T-16)', async () => {
      await setupProvider('degraded');
      const fixture = await setupRequest('degraded');

      const response = await match(fixture).expect(201);

      expect(response.body.status).toBe('MATCHED');
      expect(response.body.degraded).toBe(true);
    });

    it('eşleşmiş talep ikinci kez eşleştirilemez', async () => {
      await setupProvider('dup');
      const fixture = await setupRequest('dup');

      await match(fixture).expect(201);
      const second = await match(fixture).expect(409);

      expect(second.body.error.code).toBe('MATCHING_ALREADY_COMPLETED');

      // İkinci rezervasyon oluşmamalı.
      const bookings = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM bookings WHERE request_id = $1`,
        [fixture.requestId],
      );
      expect(bookings.rows[0]?.count).toBe('1');
    });

    it('düşük güvenli talep eşleştirilmez', async () => {
      await setupProvider('lowconf');
      const fixture = await setupRequest('lowconf');
      await pool.query(
        `UPDATE booking_requests
            SET structured_request = '{"service_type":"detayli-temizlik"}'::jsonb,
                parser_version = 'heuristic-v1', parser_confidence = 0.3
          WHERE id = $1`,
        [fixture.requestId],
      );

      const response = await match(fixture).expect(422);

      expect(response.body.error.code).toBe('MATCHING_CONFIDENCE_TOO_LOW');
    });

    it('tanınmayan zorunlu yetkinlik sessizce düşürülmez', async () => {
      await setupProvider('badskill');
      const fixture = await setupRequest('badskill');
      await pool.query(
        `UPDATE booking_requests
            SET structured_request = $2::jsonb, parser_version = 'heuristic-v1',
                parser_confidence = 0.95
          WHERE id = $1`,
        [
          fixture.requestId,
          JSON.stringify({ service_type: 'detayli-temizlik', requirements: ['uydurma-yetkinlik'] }),
        ],
      );

      const response = await match(fixture).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('bozuk structured_request eşleştirmeyi çökertmez', async () => {
      await setupProvider('malformed');
      const fixture = await setupRequest('malformed');
      await pool.query(
        `UPDATE booking_requests
            SET structured_request = $2::jsonb, parser_version = 'heuristic-v1',
                parser_confidence = 0.95
          WHERE id = $1`,
        [
          fixture.requestId,
          // Slug biçimine uymayan değerler: karar zincirine hiç girmemeli.
          JSON.stringify({ requirements: [42, { drop: 'table' }, 'BÜYÜK HARF', null] }),
        ],
      );

      const response = await match(fixture).expect(201);
      expect(response.body.status).toBe('MATCHED');
    });
  });

  describe('toplu (küresel) eşleştirme', () => {
    /**
     * `POST /matching/runs` — ADR-0018 §9'a göre **asıl yol**.
     *
     * Kapasite ve seyahat kısıtları nedeniyle talepler birlikte çözülür; tek tek
     * çözmekten farklı ve daha iyi bir sonuç üretir.
     */
    async function admin(): Promise<string> {
      const adminId = await register('mt-admin');
      await pool.query(
        `INSERT INTO user_roles (user_id, role) VALUES ($1, 'ADMIN')
         ON CONFLICT DO NOTHING`,
        [adminId],
      );
      return bearer('mt-admin');
    }

    it('birden fazla talebi tek çalıştırmada eşleştirir', async () => {
      await setupProvider('batch-a', { maxDailyBookings: 3 });
      const first = await setupRequest('batch-1');
      const second = await setupRequest('batch-2');
      const token = await admin();

      const response = await http()
        .post(`${PREFIX}/matching/runs`)
        .set('authorization', token)
        .send({ requestIds: [first.requestId, second.requestId] })
        .expect(201);

      expect(response.body).toHaveLength(2);
      expect(response.body.every((item: { runId: string }) => item.runId)).toBe(true);
    });

    it('günlük kapasite parti boyunca paylaşılır', async () => {
      // Tek uygun sağlayıcı, günlük kapasite 1, iki talep. Her talep bağımsız
      // doğrulansaydı ikisi de aynı (bayat) `dailyBookingCount = 0` anlık
      // görüntüsünü görür ve ikisi de atanırdı — sağlayıcı günde 2 iş alırdı.
      // Çakışma engeli bunu yakalamaz: saatler farklı.
      await setupProvider('batch-cap', { maxDailyBookings: 1 });
      const first = await setupRequest('batch-cap-1', { durationMinutes: 60 });
      const second = await setupRequest('batch-cap-2', { durationMinutes: 60 });
      const token = await admin();

      const response = await http()
        .post(`${PREFIX}/matching/runs`)
        .set('authorization', token)
        .send({ requestIds: [first.requestId, second.requestId] })
        .expect(201);

      const matched = response.body.filter((item: { status: string }) => item.status === 'MATCHED');
      expect(matched).toHaveLength(1);

      const bookings = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM bookings WHERE status <> 'CANCELLED'`,
      );
      expect(bookings.rows[0]?.count).toBe('1');
    });

    it('aynı talep iki kez gönderilemez', async () => {
      await setupProvider('batch-dup');
      const fixture = await setupRequest('batch-dup');
      const token = await admin();

      await http()
        .post(`${PREFIX}/matching/runs`)
        .set('authorization', token)
        .send({ requestIds: [fixture.requestId, fixture.requestId] })
        .expect(400);

      const bookings = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM bookings WHERE request_id = $1`,
        [fixture.requestId],
      );
      expect(bookings.rows[0]?.count).toBe('0');
    });

    it('ADMIN olmayan kullanıcı toplu çalıştırma tetikleyemez', async () => {
      const fixture = await setupRequest('batch-authz');

      await http()
        .post(`${PREFIX}/matching/runs`)
        .set('authorization', fixture.customerToken)
        .send({ requestIds: [fixture.requestId] })
        .expect(403);
    });

    it('tek talepten en fazla bir aktif rezervasyon çıkar', async () => {
      await setupProvider('single-booking');
      const fixture = await setupRequest('single-booking');
      await match(fixture).expect(201);

      const booking = await pool.query<{ id: string; provider_id: string }>(
        `SELECT id, provider_id FROM bookings WHERE request_id = $1`,
        [fixture.requestId],
      );

      // İkinci bir aktif rezervasyon veritabanı seviyesinde engellenir.
      await expect(
        pool.query(
          `INSERT INTO bookings
             (request_id, customer_id, provider_id, service_id, address_id,
              scheduled_start, scheduled_end, price_minor, status)
           SELECT request_id, customer_id, provider_id, service_id, address_id,
                  scheduled_start + interval '1 day', scheduled_end + interval '1 day',
                  price_minor, 'REQUESTED'
             FROM bookings WHERE id = $1`,
          [booking.rows[0]?.id],
        ),
      ).rejects.toThrow();
    });
  });

  describe('sağlayıcı beyanlarının sınırları', () => {
    it('sağlayıcı başına hizmet bölgesi sayısı veritabanında sınırlıdır', async () => {
      // Sınırsız bölge iki şeyi mümkün kılardı: mesafe referans noktasını istenen
      // yere taşıyıp `distance_score` satın almak ve her müşterinin aday havuzu
      // sorgusunu yavaşlatmak (R-51).
      const providerId = await setupProvider('area-cap');
      const token = bearer('mt-provider-area-cap');

      // setupProvider bir bölge ekledi; dördü daha sınıra kadar geçer.
      for (let index = 0; index < 4; index += 1) {
        await http()
          .post(`${PREFIX}/providers/me/service-areas`)
          .set('authorization', token)
          .send({
            name: `Ek bölge ${index}`,
            latitude: 40.99,
            longitude: 29.03,
            radiusMeters: 5_000,
          })
          .expect(201);
      }

      await http()
        .post(`${PREFIX}/providers/me/service-areas`)
        .set('authorization', token)
        .send({ name: 'Altıncı', latitude: 40.99, longitude: 29.03, radiusMeters: 5_000 })
        .expect(409);

      const areas = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM provider_service_areas WHERE provider_id = $1`,
        [providerId],
      );
      expect(areas.rows[0]?.count).toBe('5');
    });

    it('kapasite değişikliği ayrı bir audit eylemi olarak kaydedilir', async () => {
      await setupProvider('cap-audit');
      const token = bearer('mt-provider-cap-audit');
      const sinceId = await currentAuditMaxId(pool);

      await http()
        .patch(`${PREFIX}/providers/me`)
        .set('authorization', token)
        .send({ maxDailyBookings: 5 })
        .expect(200);

      const actions = await auditActionsSince(pool, sinceId);
      expect(actions).toContain('PROVIDER_CAPACITY_UPDATED');
    });

    it('bölge silme de kaydedilir', async () => {
      await setupProvider('area-audit');
      const token = bearer('mt-provider-area-audit');
      const areas = await http()
        .get(`${PREFIX}/providers/me/service-areas`)
        .set('authorization', token)
        .expect(200);
      const sinceId = await currentAuditMaxId(pool);

      await http()
        .delete(`${PREFIX}/providers/me/service-areas/${areas.body[0].id}`)
        .set('authorization', token)
        .expect(204);

      expect(await auditActionsSince(pool, sinceId)).toContain('SERVICE_AREA_REMOVED');
    });

    it('sağlayıcı iki uzak bölgede çalışsa da kapsayan bölgeden aday olur', async () => {
      // Tüm bölgelerin birleşiminin merkezi alınsaydı, merkez ikisinin de dışına
      // düşer ve adres bir poligonun tam içindeyken sağlayıcı "çok uzak" diye
      // elenebilirdi.
      const token = bearer('mt-provider-split');
      await setupProvider('split', { areaRadiusMeters: 5_000 });
      await http()
        .post(`${PREFIX}/providers/me/service-areas`)
        .set('authorization', token)
        .send({
          // Ankara civarı: adresten ~350 km uzakta.
          name: 'Uzak bölge',
          latitude: 39.9334,
          longitude: 32.8597,
          radiusMeters: 20_000,
        })
        .expect(201);

      const fixture = await setupRequest('split');
      const response = await match(fixture).expect(201);

      expect(response.body.status).toBe('MATCHED');
    });
  });

  describe('katalog ↔ motor şeması', () => {
    /**
     * Seed'deki slug'lar, AI servisinin kapalı `Literal` kümesiyle aynı olmalı.
     *
     * Ayrışırlarsa o hizmeti isteyen her talep motorda 422 alır ve **kalıcı olarak**
     * yalnızca mesafeye göre eşleşir. Zincirin diğer halkası AI tarafındadır:
     * `services/ai/tests/test_catalog_slugs.py` aynı dosyayı `Literal`'larla
     * karşılaştırır.
     */
    const manifest = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../packages/api-contracts/matching/catalog-slugs.json'),
        'utf8',
      ),
    ) as { serviceSlugs: string[]; skillSlugs: string[] };

    it('seed edilmiş hizmet slug.ları sözleşmeyle aynıdır', async () => {
      const rows = await pool.query<{ slug: string }>(`SELECT slug FROM services ORDER BY slug`);

      expect(rows.rows.map((row) => row.slug)).toEqual([...manifest.serviceSlugs].sort());
    });

    it('seed edilmiş yetkinlik slug.ları sözleşmeyle aynıdır', async () => {
      const rows = await pool.query<{ slug: string }>(`SELECT slug FROM skills ORDER BY slug`);

      expect(rows.rows.map((row) => row.slug)).toEqual([...manifest.skillSlugs].sort());
    });
  });

  describe('yetkilendirme ve veri sızıntısı', () => {
    it('başkasının talebi eşleştirilemez', async () => {
      await setupProvider('authz');
      const fixture = await setupRequest('authz');
      const intruderId = await register('mt-intruder');
      expect(intruderId).toEqual(expect.any(String));

      await http()
        .post(`${PREFIX}/booking-requests/${fixture.requestId}/match`)
        .set('authorization', bearer('mt-intruder'))
        .expect(404);
    });

    it('kimlik doğrulamasız çağrı reddedilir', async () => {
      const fixture = await setupRequest('anon');

      await http().post(`${PREFIX}/booking-requests/${fixture.requestId}/match`).expect(401);
    });

    it('müşteri yanıtı skor bileşeni ve diğer adayları içermez (T-19)', async () => {
      await setupProvider('leak-a');
      await setupProvider('leak-b', {
        areaLatitude: 41.01,
        areaLongitude: 29.05,
        areaRadiusMeters: 8_000,
      });
      const fixture = await setupRequest('leak');

      const response = await match(fixture).expect(201);
      const serialized = JSON.stringify(response.body);

      expect(response.body).not.toHaveProperty('candidates');
      expect(response.body).not.toHaveProperty('rankings');
      expect(serialized).not.toContain('skillScore');
      expect(serialized).not.toContain('overallScore');
      // Yalnızca seçilen sağlayıcının adı döner; diğer adayların kimliği yoktur.
      expect(response.body.providerName).toEqual(expect.any(String));
    });

    it('operasyon görünümü ADMIN dışına kapalıdır', async () => {
      await setupProvider('ops');
      const fixture = await setupRequest('ops');
      await match(fixture).expect(201);

      await http()
        .get(`${PREFIX}/matching/runs/${fixture.requestId}`)
        .set('authorization', fixture.customerToken)
        .expect(403);
    });

    it('müşteri kendi sonucunu okuyabilir, başkası okuyamaz', async () => {
      await setupProvider('read');
      const fixture = await setupRequest('read');
      await match(fixture).expect(201);
      await register('mt-reader');

      const own = await http()
        .get(`${PREFIX}/booking-requests/${fixture.requestId}/match`)
        .set('authorization', fixture.customerToken)
        .expect(200);
      expect(own.body.status).toBe('MATCHED');

      await http()
        .get(`${PREFIX}/booking-requests/${fixture.requestId}/match`)
        .set('authorization', bearer('mt-reader'))
        .expect(404);
    });
  });
});
