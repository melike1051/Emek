import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { BookingsService } from '../src/bookings/bookings.service';
import { MockStorageProvider } from '../src/documents/mock-storage-provider';
import { StorageError } from '../src/documents/storage.port';
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
 * Dijital ispat dokümanları (T-12).
 *
 * Doğrulanan iddialar: nesneler private'tır ve yalnızca kısa ömürlü signed URL ile
 * erişilebilir; süresi dolmuş/kurcalanmış URL reddedilir; `sha256` storage'daki
 * nesneden okunur ve sonradan değiştirilemez.
 */
describe('documents (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let storage: MockStorageProvider;

  interface Fixture {
    customerToken: string;
    providerToken: string;
    bookingId: string;
  }

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    redis = createRedis();
    storage = app.get(MockStorageProvider);
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

  /** Hizmeti gerçek geçişlerle başlatır: kanıt fotoğrafı `CHECKED_IN` sonrasında çekilir. */
  async function setupBooking(seed: string): Promise<Fixture> {
    await register(`doc-customer-${seed}`);
    const providerId = await register(`doc-provider-${seed}`);
    const customerToken = bearer(`doc-customer-${seed}`);
    const providerToken = bearer(`doc-provider-${seed}`);

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

    return { customerToken, providerToken, bookingId: booking.body.id as string };
  }

  async function registerDocument(
    fixture: Fixture,
    documentType = 'BEFORE_PHOTO',
  ): Promise<{ id: string; uploadUrl: string }> {
    const response = await http()
      .post(`${PREFIX}/documents`)
      .set('authorization', fixture.providerToken)
      .send({ bookingId: fixture.bookingId, documentType, contentType: 'image/jpeg' })
      .expect(201);

    return {
      id: response.body.document.id as string,
      uploadUrl: response.body.uploadUrl as string,
    };
  }

  const PHOTO = Buffer.from('before-photo-bytes');
  const PHOTO_SHA = createHash('sha256').update(PHOTO).digest('hex');

  describe('kayıt ve yükleme', () => {
    it('kanıt dokümanı kaydedilir, yüklenir ve hash storage.tan okunur', async () => {
      const fixture = await setupBooking('happy');
      const document = await registerDocument(fixture);

      // Dosya API'den geçmez: doğrudan storage'a imzalı URL ile yüklenir.
      storage.putWithSignedUrl(document.uploadUrl, 'image/jpeg', PHOTO);

      const confirmed = await http()
        .post(`${PREFIX}/documents/${document.id}/confirm`)
        .set('authorization', fixture.providerToken)
        .send({ sha256: PHOTO_SHA })
        .expect(201);

      expect(confirmed.body.status).toBe('AVAILABLE');
      expect(confirmed.body.sha256).toBe(PHOTO_SHA);
      expect(confirmed.body.sizeBytes).toBe(String(PHOTO.byteLength));
      // Bucket içi yol istemciye sızmaz.
      expect(confirmed.body.storageKey).toBeUndefined();
    });

    /**
     * İstemcinin bildirdiği hash kanıt değildir: kaydedilen değer storage'daki nesneden
     * okunur, beyanla uyuşmazsa istek reddedilir.
     */
    it('beyan edilen hash yüklenen dosyayla uyuşmazsa reddedilir', async () => {
      const fixture = await setupBooking('hash-mismatch');
      const document = await registerDocument(fixture);
      storage.putWithSignedUrl(document.uploadUrl, 'image/jpeg', PHOTO);

      const response = await http()
        .post(`${PREFIX}/documents/${document.id}/confirm`)
        .set('authorization', fixture.providerToken)
        .send({ sha256: 'a'.repeat(64) })
        .expect(422);

      expect(response.body.error.code).toBe('DOCUMENT_INTEGRITY_MISMATCH');

      const row = await pool.query<{ status: string; sha256: string | null }>(
        `SELECT status, sha256 FROM documents WHERE id = $1`,
        [document.id],
      );
      expect(row.rows[0]?.status).toBe('PENDING_UPLOAD');
      expect(row.rows[0]?.sha256).toBeNull();
    });

    it('yüklenmemiş doküman onaylanamaz', async () => {
      const fixture = await setupBooking('not-uploaded');
      const document = await registerDocument(fixture);

      await http()
        .post(`${PREFIX}/documents/${document.id}/confirm`)
        .set('authorization', fixture.providerToken)
        .send({})
        .expect(404);
    });

    /**
     * Boyut sınırı yükleme **sonrasında** da doğrulanır: imzalı URL'e eklenen başlık bir
     * niyet beyanıdır, gerçek storage'da sınırı uygulamaz (Faz 5 review bulgusu H2).
     */
    it('boyut sınırını aşan dosya onaylanmaz', async () => {
      const fixture = await setupBooking('too-large');
      const document = await registerDocument(fixture);

      const oversized = Buffer.alloc(11 * 1024 * 1024, 1);
      // Storage sınırı uygulamamış gibi davranır: nesne yine de oraya yazılmış olabilir.
      storage.forcePut(document.uploadUrl, 'image/jpeg', oversized);

      const response = await http()
        .post(`${PREFIX}/documents/${document.id}/confirm`)
        .set('authorization', fixture.providerToken)
        .send({})
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_FAILED');

      const row = await pool.query<{ status: string }>(
        `SELECT status FROM documents WHERE id = $1`,
        [document.id],
      );
      expect(row.rows[0]?.status).toBe('PENDING_UPLOAD');
    });

    it('desteklenmeyen dosya türü reddedilir', async () => {
      const fixture = await setupBooking('bad-type');

      await http()
        .post(`${PREFIX}/documents`)
        .set('authorization', fixture.providerToken)
        .send({
          bookingId: fixture.bookingId,
          documentType: 'BEFORE_PHOTO',
          contentType: 'application/x-msdownload',
        })
        .expect(400);
    });

    it('rezervasyonun tarafı olmayan kullanıcı kanıt ekleyemez', async () => {
      const fixture = await setupBooking('outsider-upload');
      await register('doc-outsider');

      await http()
        .post(`${PREFIX}/documents`)
        .set('authorization', bearer('doc-outsider'))
        .send({
          bookingId: fixture.bookingId,
          documentType: 'AFTER_PHOTO',
          contentType: 'image/jpeg',
        })
        .expect(404);
    });

    /** Kanıt zinciri sonradan uyarlanamaz: hash yazıldıktan sonra değişmez (trigger). */
    it('kaydedilmiş hash veritabanı seviyesinde değiştirilemez', async () => {
      const fixture = await setupBooking('immutable-hash');
      const document = await registerDocument(fixture);
      storage.putWithSignedUrl(document.uploadUrl, 'image/jpeg', PHOTO);

      await http()
        .post(`${PREFIX}/documents/${document.id}/confirm`)
        .set('authorization', fixture.providerToken)
        .send({})
        .expect(201);

      await expect(
        pool.query(`UPDATE documents SET sha256 = $2 WHERE id = $1`, [document.id, 'b'.repeat(64)]),
      ).rejects.toThrow(/değiştirilemez/);

      await expect(
        pool.query(`UPDATE documents SET storage_key = 'documents/hijack' WHERE id = $1`, [
          document.id,
        ]),
      ).rejects.toThrow(/değiştirilemez/);
    });
  });

  // T-12: nesneler private; erişim yalnızca kısa ömürlü signed URL ile.
  describe('erişim', () => {
    async function uploadedDocument(fixture: Fixture): Promise<string> {
      const document = await registerDocument(fixture);
      storage.putWithSignedUrl(document.uploadUrl, 'image/jpeg', PHOTO);
      await http()
        .post(`${PREFIX}/documents/${document.id}/confirm`)
        .set('authorization', fixture.providerToken)
        .send({})
        .expect(201);
      return document.id;
    }

    it('taraflar kısa ömürlü imzalı URL ile erişir', async () => {
      const fixture = await setupBooking('access');
      const documentId = await uploadedDocument(fixture);

      const signed = await http()
        .get(`${PREFIX}/documents/${documentId}/download-url`)
        .set('authorization', fixture.customerToken)
        .expect(200);

      const expiresAt = new Date(signed.body.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThan(Date.now());
      // Kısa ömür: uzun ömürlü imzalı URL pratikte public link demektir.
      expect(expiresAt - Date.now()).toBeLessThanOrEqual(3600 * 1000);

      expect(storage.getWithSignedUrl(signed.body.url)).toEqual(PHOTO);
    });

    it('imzasız veya kurcalanmış URL ile erişilemez', async () => {
      const fixture = await setupBooking('tampered');
      const documentId = await uploadedDocument(fixture);

      const signed = await http()
        .get(`${PREFIX}/documents/${documentId}/download-url`)
        .set('authorization', fixture.customerToken)
        .expect(200);

      const url = new URL(signed.body.url);
      // İmzasız: nesne yolu bilinse bile erişilemez.
      const unsigned = `${url.origin}${url.pathname}`;
      expect(() => storage.getWithSignedUrl(unsigned)).toThrow(StorageError);

      // Kurcalanmış imza.
      url.searchParams.set('signature', 'c'.repeat(64));
      expect(() => storage.getWithSignedUrl(url.toString())).toThrow(/signature/);
    });

    it('süresi dolmuş imzalı URL reddedilir', async () => {
      const fixture = await setupBooking('expired-url');
      const documentId = await uploadedDocument(fixture);

      const signed = await http()
        .get(`${PREFIX}/documents/${documentId}/download-url`)
        .set('authorization', fixture.customerToken)
        .expect(200);

      // Süre geçmişe çekilir. İmza da bozulur ama **süre kontrolü imza kontrolünden
      // önce** yapılır: süresi dolmuş bir URL, imzası geçerli olsa bile reddedilir.
      const expired = new URL(signed.body.url);
      expired.searchParams.set('expires', String(Date.now() - 1000));

      expect(() => storage.getWithSignedUrl(expired.toString())).toThrow(/expired/);
      // Geçerli URL hâlâ çalışıyor: reddedilen şey süre, imza mekanizması değil.
      expect(storage.getWithSignedUrl(signed.body.url)).toEqual(PHOTO);
    });

    it('taraf olmayan kullanıcı indirme URL.i alamaz', async () => {
      const fixture = await setupBooking('access-denied');
      const documentId = await uploadedDocument(fixture);
      await register('doc-stranger');

      await http()
        .get(`${PREFIX}/documents/${documentId}/download-url`)
        .set('authorization', bearer('doc-stranger'))
        .expect(404);
    });

    it('her erişim audit.lenir', async () => {
      const fixture = await setupBooking('audit');
      const documentId = await uploadedDocument(fixture);

      await http()
        .get(`${PREFIX}/documents/${documentId}/download-url`)
        .set('authorization', fixture.customerToken)
        .expect(200);

      const audit = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
          WHERE action = 'DOCUMENT_ACCESS_GRANTED' AND entity_id = $1`,
        [documentId],
      );
      expect(audit.rows[0]?.count).toBe('1');
    });

    it('rezervasyon kanıtları yalnızca taraflara listelenir', async () => {
      const fixture = await setupBooking('list');
      await uploadedDocument(fixture);
      await register('doc-list-stranger');

      const listed = await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}/documents`)
        .set('authorization', fixture.customerToken)
        .expect(200);
      expect(listed.body).toHaveLength(1);

      await http()
        .get(`${PREFIX}/bookings/${fixture.bookingId}/documents`)
        .set('authorization', bearer('doc-list-stranger'))
        .expect(404);
    });
  });

  describe('kanıt-rezervasyon ilişkisi', () => {
    it('kanıt tipi rezervasyonsuz kaydedilemez', async () => {
      await setupBooking('needs-booking');

      await http()
        .post(`${PREFIX}/documents`)
        .set('authorization', bearer('doc-provider-needs-booking'))
        .send({ documentType: 'AFTER_PHOTO', contentType: 'image/jpeg' })
        .expect(400);
    });

    it('yükleme tamamlanınca kanıt event.i outbox.a yazılır', async () => {
      const fixture = await setupBooking('event');
      const document = await registerDocument(fixture, 'AFTER_PHOTO');
      storage.putWithSignedUrl(document.uploadUrl, 'image/jpeg', PHOTO);

      await http()
        .post(`${PREFIX}/documents/${document.id}/confirm`)
        .set('authorization', fixture.providerToken)
        .send({})
        .expect(201);

      const events = await pool.query<{ event_type: string; payload: { documentId: string } }>(
        `SELECT event_type, payload FROM outbox WHERE event_type = 'ServiceEvidenceAdded'`,
      );
      expect(events.rows[0]?.payload.documentId).toBe(document.id);
    });

    it('rezervasyon ilerlemesi kanıt eklemeyi engellemez', async () => {
      // Hizmet sırasında ve sonrasında kanıt eklenebilmeli: "öncesi/sonrası" akışı budur.
      const fixture = await setupBooking('progress');
      const bookings = app.get(BookingsService);
      for (const to of ['MATCHED', 'PROVIDER_PENDING'] as const) {
        await bookings.advanceBySystem({ bookingId: fixture.bookingId, to });
      }

      const document = await registerDocument(fixture, 'AFTER_PHOTO');
      expect(document.id).toBeDefined();
    });
  });
});
