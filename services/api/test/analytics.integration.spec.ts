import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { BookingsService } from '../src/bookings/bookings.service';
import { MockPaymentProvider } from '../src/payments/mock-payment-provider';
import { BIGQUERY_PORT } from '../src/analytics/bigquery.port';
import { BigQueryExportService } from '../src/analytics/bigquery-export.service';
import type { MockBigQueryAdapter } from '../src/analytics/mock-bigquery-adapter';
import { ReconciliationService } from '../src/analytics/reconciliation.service';
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
 * Faz 11 — Analytics / BigQuery export + ödeme mutabakatı (EXP-006, ADR-0021).
 *
 * `BIGQUERY_PORT` gerçek GCP yerine `MockBigQueryAdapter` ile değiştirilir (yalnızca
 * dış servis sınırı — domain servisleri gerçek kodla çalışır, `test-app.ts` doc'u).
 */
describe('analytics: BigQuery export + payment reconciliation (Faz 11)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let exportService: BigQueryExportService;
  let reconciliation: ReconciliationService;
  let bigQuery: MockBigQueryAdapter;

  interface Fixture {
    customerToken: string;
    providerToken: string;
    bookingId: string;
  }

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    redis = createRedis();
    exportService = app.get(BigQueryExportService);
    reconciliation = app.get(ReconciliationService);
    bigQuery = app.get(BIGQUERY_PORT) as MockBigQueryAdapter;
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);
    app.get(MockPaymentProvider).setUnavailable(false);
    app.get(MockPaymentProvider).setDeclineNext(false);
    bigQuery.reset();
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

  /** `scheduled-release.integration.spec.ts` ile aynı fikstür (gerçek geçiş yolu). */
  async function setupConfirmedBooking(seed: string): Promise<Fixture> {
    await register(`an-customer-${seed}`);
    const providerId = await register(`an-provider-${seed}`);
    const customerToken = bearer(`an-customer-${seed}`);
    const providerToken = bearer(`an-provider-${seed}`);

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

  function insertAnalyticsEvent(overrides: Partial<{ eventVersion: number }> = {}) {
    const eventId = randomUUID();
    return pool
      .query(
        `INSERT INTO analytics_events
           (event_id, event_type, event_version, aggregate_type, aggregate_id, occurred_at, correlation_id, payload)
         VALUES ($1, 'BookingCreated', $2, 'Booking', $3, now(), NULL, $4)`,
        [eventId, overrides.eventVersion ?? 1, randomUUID(), JSON.stringify({ bookingId: 'b-1' })],
      )
      .then(() => eventId);
  }

  // --- BigQuery export: ingestion/idempotency ---

  describe('BigQuery export', () => {
    it('exported_at NULL olan satırları export eder ve işaretler (ingestion)', async () => {
      await insertAnalyticsEvent();
      await insertAnalyticsEvent();

      const exported = await exportService.exportBatch();
      expect(exported).toBe(2);

      const remaining = await pool.query(
        `SELECT count(*)::int AS count FROM analytics_events WHERE exported_at IS NULL`,
      );
      expect(remaining.rows[0].count).toBe(0);

      const table = bigQuery.tables.get('raw_events');
      expect(table?.size).toBe(2);
    });

    it('ikinci tur zaten export edilmiş satırları tekrar göndermez (idempotency)', async () => {
      await insertAnalyticsEvent();
      expect(await exportService.exportBatch()).toBe(1);
      expect(await exportService.exportBatch()).toBe(0);
    });

    it('event_version korunur ve export edilir (sürüm elenmez)', async () => {
      await insertAnalyticsEvent({ eventVersion: 2 });
      await exportService.exportBatch();

      const table = bigQuery.tables.get('raw_events');
      const row = [...(table?.values() ?? [])][0];
      expect(row?.eventVersion).toBe(2);
    });

    it('BigQuery hatası exported_at işaretlemez — transactional durum bozulmaz (data-quality failure)', async () => {
      const eventId = await insertAnalyticsEvent();
      bigQuery.failNextInsert = true;

      const exported = await exportService.exportBatch();
      expect(exported).toBe(0);

      const row = await pool.query(`SELECT exported_at FROM analytics_events WHERE event_id = $1`, [
        eventId,
      ]);
      expect(row.rows[0].exported_at).toBeNull();

      // Kira süresi dolunca (veya hemen, testte lease çok kısa değil ama claim WHERE
      // koşulu export_claimed_until <= now() OR NULL'dır — önceki claim hâlâ kirada
      // olduğu için bir sonraki export bu satırı hemen tekrar denemez) — davranış
      // dürüstçe budur: kira süresi dolana kadar tekrar denenmez, kaybolmaz.
      const claimed = await pool.query(
        `SELECT export_claimed_until FROM analytics_events WHERE event_id = $1`,
        [eventId],
      );
      expect(claimed.rows[0].export_claimed_until).not.toBeNull();
    });

    it('kira süresi dolmadan ikinci worker aynı satırı tekrar sahiplenemez (concurrency)', async () => {
      await insertAnalyticsEvent();
      await insertAnalyticsEvent();

      const [first, second] = await Promise.all([
        exportService.exportBatch(),
        exportService.exportBatch(),
      ]);

      // Toplam 2 satır var; atomik claim (FOR UPDATE SKIP LOCKED) sayesinde ikisi
      // birlikte tam olarak 2 satırı (ne az ne fazla, hiç çakışmadan) export eder.
      expect(first + second).toBe(2);
      expect(bigQuery.tables.get('raw_events')?.size).toBe(2);
    });

    it('export durum uç noktası bekleyen satır sayısını raporlar', async () => {
      await insertAnalyticsEvent();
      await insertAnalyticsEvent();
      await exportService.exportBatch();
      await insertAnalyticsEvent();

      const status = await exportService.status();
      expect(status.unexportedCount).toBe(1);
      expect(status.lastExportedAt).not.toBeNull();
    });
  });

  // --- Reconciliation ---

  describe('payment reconciliation', () => {
    it('STUCK_PENDING_COMMAND: yanıtsız kalmış komut tespit edilir', async () => {
      const fixture = await setupConfirmedBooking('stuck');
      const paymentId = await authorize(fixture);
      expect(['AUTHORIZED', 'HELD']).toContain(await paymentStatus(paymentId));

      // Gerçek bir sağlayıcı çağrısının "belirsiz" kalması simüle edilir: komut
      // PENDING'de yaratılır ve kira penceresinin dışına backdate edilir.
      await pool.query(
        `INSERT INTO payment_commands (payment_id, operation, idempotency_key, status, created_at)
         VALUES ($1, 'CAPTURE', $2, 'PENDING', now() - interval '30 minutes')`,
        [paymentId, randomUUID()],
      );

      const summary = await reconciliation.run('MANUAL');
      expect(summary.newDiscrepancyCount).toBe(1);

      const rows = await pool.query(
        `SELECT discrepancy_type, details FROM payment_reconciliation_discrepancies WHERE payment_id = $1`,
        [paymentId],
      );
      expect(rows.rows[0].discrepancy_type).toBe('STUCK_PENDING_COMMAND');
      expect(rows.rows[0].details.operation).toBe('CAPTURE');

      // Para hareketi tetiklemedi: ödeme durumu değişmedi.
      expect(['AUTHORIZED', 'HELD']).toContain(await paymentStatus(paymentId));
    });

    it('AUTHORIZATION_EXPIRED_UNHANDLED: süresi dolmuş ama işlenmemiş yetki tespit edilir', async () => {
      const fixture = await setupConfirmedBooking('expired');
      const paymentId = await authorize(fixture);

      await pool.query(
        `UPDATE payments SET authorization_expires_at = now() - interval '2 hours' WHERE id = $1`,
        [paymentId],
      );

      const summary = await reconciliation.run('MANUAL');
      expect(summary.newDiscrepancyCount).toBe(1);

      const rows = await pool.query(
        `SELECT discrepancy_type FROM payment_reconciliation_discrepancies WHERE payment_id = $1`,
        [paymentId],
      );
      expect(rows.rows[0].discrepancy_type).toBe('AUTHORIZATION_EXPIRED_UNHANDLED');
    });

    it('AUTHORIZATION_EXPIRED_UNHANDLED: bağışıklık penceresi içindeyken bayraklanmaz', async () => {
      const fixture = await setupConfirmedBooking('grace');
      const paymentId = await authorize(fixture);

      await pool.query(
        `UPDATE payments SET authorization_expires_at = now() - interval '5 minutes' WHERE id = $1`,
        [paymentId],
      );

      const summary = await reconciliation.run('MANUAL');
      expect(summary.newDiscrepancyCount).toBe(0);
    });

    it('RELEASE_PENDING_STALLED: takılı release tespit edilir', async () => {
      const fixture = await setupConfirmedBooking('stalled');
      const paymentId = await authorize(fixture);

      await pool.query(`ALTER TABLE payments DISABLE TRIGGER payments_set_updated_at`);
      try {
        await pool.query(
          `UPDATE payments
              SET status = 'RELEASE_PENDING', updated_at = now() - interval '3 hours'
            WHERE id = $1`,
          [paymentId],
        );
      } finally {
        await pool.query(`ALTER TABLE payments ENABLE TRIGGER payments_set_updated_at`);
      }

      const summary = await reconciliation.run('MANUAL');
      expect(summary.newDiscrepancyCount).toBe(1);

      const rows = await pool.query(
        `SELECT discrepancy_type FROM payment_reconciliation_discrepancies WHERE payment_id = $1`,
        [paymentId],
      );
      expect(rows.rows[0].discrepancy_type).toBe('RELEASE_PENDING_STALLED');
    });

    it('aynı bulgu ikinci turda tekrar yazılmaz (dedup)', async () => {
      const fixture = await setupConfirmedBooking('dedup');
      const paymentId = await authorize(fixture);
      await pool.query(
        `INSERT INTO payment_commands (payment_id, operation, idempotency_key, status, created_at)
         VALUES ($1, 'CAPTURE', $2, 'PENDING', now() - interval '30 minutes')`,
        [paymentId, randomUUID()],
      );

      const first = await reconciliation.run('MANUAL');
      expect(first.newDiscrepancyCount).toBe(1);
      expect(first.discrepancyCount).toBe(1);

      const second = await reconciliation.run('MANUAL');
      expect(second.newDiscrepancyCount).toBe(0);
      expect(second.discrepancyCount).toBe(1); // hâlâ adaydır, yalnızca yeniden yazılmaz

      const rows = await pool.query(
        `SELECT count(*)::int AS count FROM payment_reconciliation_discrepancies WHERE payment_id = $1`,
        [paymentId],
      );
      expect(rows.rows[0].count).toBe(1);
    });

    it('bulgu detayları yalnızca beklenen alanları taşır (veri minimizasyonu)', async () => {
      const fixture = await setupConfirmedBooking('minimize');
      const paymentId = await authorize(fixture);
      await pool.query(
        `INSERT INTO payment_commands (payment_id, operation, idempotency_key, status, created_at)
         VALUES ($1, 'CAPTURE', $2, 'PENDING', now() - interval '30 minutes')`,
        [paymentId, randomUUID()],
      );
      await reconciliation.run('MANUAL');

      const rows = await pool.query<{ details: Record<string, unknown> }>(
        `SELECT details FROM payment_reconciliation_discrepancies WHERE payment_id = $1`,
        [paymentId],
      );
      const allowedKeys = ['commandId', 'operation', 'attempt', 'createdAt', 'ageMinutes'];
      expect(Object.keys(rows.rows[0]!.details).sort()).toEqual(allowedKeys.sort());
    });
  });

  // --- Admin endpoints (RBAC) ---

  describe('admin endpoints', () => {
    async function setupDiscrepancy(seed: string): Promise<{ paymentId: string }> {
      const fixture = await setupConfirmedBooking(seed);
      const paymentId = await authorize(fixture);
      await pool.query(
        `INSERT INTO payment_commands (payment_id, operation, idempotency_key, status, created_at)
         VALUES ($1, 'CAPTURE', $2, 'PENDING', now() - interval '30 minutes')`,
        [paymentId, randomUUID()],
      );
      return { paymentId };
    }

    it('SUPPORT bulguları listeleyebilir ama tetikleyemez/kapatamaz (403)', async () => {
      const supportId = await register('an-support-1');
      await grant(supportId, 'SUPPORT');
      const supportToken = bearer('an-support-1');

      await setupDiscrepancy('rbac');
      await reconciliation.run('MANUAL');

      await http()
        .get(`${PREFIX}/analytics/reconciliation`)
        .set('authorization', supportToken)
        .expect(200);

      await http()
        .post(`${PREFIX}/analytics/reconciliation/run`)
        .set('authorization', supportToken)
        .send({})
        .expect(403);
    });

    it('ADMIN manuel tur tetikleyebilir ve bulguyu kapatabilir (audit ile)', async () => {
      const adminId = await register('an-admin-1');
      await grant(adminId, 'ADMIN');
      const adminToken = bearer('an-admin-1');

      await setupDiscrepancy('admin');

      const runResponse = await http()
        .post(`${PREFIX}/analytics/reconciliation/run`)
        .set('authorization', adminToken)
        .send({})
        .expect(200);
      expect(runResponse.body.newDiscrepancyCount).toBe(1);

      const list = await http()
        .get(`${PREFIX}/analytics/reconciliation`)
        .set('authorization', adminToken)
        .expect(200);
      const discrepancyId = list.body.items[0].id as string;

      await http()
        .post(`${PREFIX}/analytics/reconciliation/${discrepancyId}/resolve`)
        .set('authorization', adminToken)
        .send({})
        .expect(200);

      const resolved = await pool.query(
        `SELECT resolved_at, resolved_by FROM payment_reconciliation_discrepancies WHERE id = $1`,
        [discrepancyId],
      );
      expect(resolved.rows[0].resolved_at).not.toBeNull();
      expect(resolved.rows[0].resolved_by).toBe(adminId);

      const audit = await pool.query(
        `SELECT action FROM audit_logs WHERE action IN ('RECONCILIATION_RUN_COMPLETED', 'RECONCILIATION_DISCREPANCY_RESOLVED') ORDER BY id`,
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        'RECONCILIATION_RUN_COMPLETED',
        'RECONCILIATION_DISCREPANCY_RESOLVED',
      ]);
    });
  });

  // --- Regression: Faz 5 authorize akışı Faz 11 ile değişmedi ---

  it('regresyon: normal yetkilendirme akışı export/mutabakat kapalıyken (varsayılan) etkilenmez', async () => {
    const fixture = await setupConfirmedBooking('regression');
    const paymentId = await authorize(fixture);
    expect(['AUTHORIZED', 'HELD']).toContain(await paymentStatus(paymentId));
  });

  async function paymentStatus(paymentId: string): Promise<string> {
    const rows = await pool.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [
      paymentId,
    ]);
    return rows.rows[0]!.status;
  }
});
