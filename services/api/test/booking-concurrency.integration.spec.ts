import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { POSTGRES_POOL } from '../src/common/database/database.tokens';
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
 * Faz 14 — booking eşzamanlılık regresyonları.
 *
 * Bu paket, yük ölçümünde (EXP-007) bulunan **havuz kendi kendine kilitlenmesi**
 * bulgusunu sabitler: `createWithin` bir transaction bağlantısını tutarken, aynı
 * havuzdan **ikinci** bir bağlantı isteyen çağrılar yapıyordu (`addresses.findOwned`,
 * `catalog.priceFor` → `uow.query()` → `pool.query()`). Uçuştaki istek sayısı havuz
 * boyutuna ulaştığında her bağlantı, asla serbest kalmayacak ikinci bir bağlantıyı
 * bekleyen bir transaction tarafından tutuluyor; hepsi `connectionTimeoutMillis`
 * sonunda 500 ile düşüyordu.
 *
 * Kritik nokta: bu, slot çakışmasından **bağımsızdır**. Aşağıdaki testler bilinçli
 * olarak birbiriyle hiç çakışmayan rezervasyonlar kullanır — böylece ölçülen şey
 * kilit yarışı değil, istek başına bağlantı çoğaltmasıdır.
 */
describe('booking eşzamanlılık (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let poolMax: number;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    redis = createRedis();
    poolMax = app.get<Pool>(POSTGRES_POOL).options.max ?? 10;
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

  interface Actor {
    token: string;
    providerId: string;
    addressId: string;
    serviceId: string;
    start: string;
    end: string;
  }

  /**
   * `count` adet aktör üretir. `sameSlot` false ise her aktörün kendi sağlayıcısı ve
   * kendi zaman aralığı olur: hiçbir rezervasyon diğeriyle çakışmaz.
   */
  async function setupActors(count: number, sameSlot: boolean): Promise<Actor[]> {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 1);
    const windowStart = new Date(day);
    windowStart.setUTCHours(6, 0, 0, 0);
    const windowEnd = new Date(day);
    windowEnd.setUTCHours(22, 0, 0, 0);

    const services = await http().get(`${PREFIX}/services`).expect(200);
    const serviceId = services.body[0].id as string;

    const actors: Actor[] = [];
    for (let index = 0; index < count; index += 1) {
      // Oran sınırı gerçek ve etkindir; kurulum ölçülmediği için sayaç burada
      // temizlenir (mevcut integration testleriyle aynı yaklaşım).
      await clearRateLimits(redis);

      const customerToken = bearer(`conc-c-${sameSlot ? 'same' : 'dist'}-${count}-${index}`);
      const providerToken = bearer(`conc-p-${sameSlot ? 'same' : 'dist'}-${count}-${index}`);

      await http().post(`${PREFIX}/auth/session`).set('authorization', customerToken).expect(201);
      const providerSession = await http()
        .post(`${PREFIX}/auth/session`)
        .set('authorization', providerToken)
        .expect(201);

      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', customerToken)
        .send({ displayName: `Eşzamanlı Müşteri ${index}` })
        .expect(201);
      await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', providerToken)
        .send({ displayName: `Eşzamanlı Sağlayıcı ${index}` })
        .expect(201);

      const address = await http()
        .post(`${PREFIX}/addresses`)
        .set('authorization', customerToken)
        .send({
          city: 'İstanbul',
          district: 'Kadıköy',
          line: `Eşzamanlı Sokak ${index}`,
          latitude: 40.9909,
          longitude: 29.0303,
        })
        .expect(201);

      await http()
        .post(`${PREFIX}/providers/me/availability`)
        .set('authorization', providerToken)
        .send({ startsAt: windowStart.toISOString(), endsAt: windowEnd.toISOString() })
        .expect(201);

      const start = new Date(day);
      start.setUTCHours(7, 0, 0, 0);
      const slotStart = new Date(start.getTime() + (sameSlot ? 0 : index * 60 * 60 * 1000));

      actors.push({
        token: customerToken,
        providerId: sameSlot
          ? (actors[0]?.providerId ?? (providerSession.body.userId as string))
          : (providerSession.body.userId as string),
        addressId: address.body.id as string,
        serviceId,
        start: slotStart.toISOString(),
        end: new Date(slotStart.getTime() + 30 * 60 * 1000).toISOString(),
      });
    }
    return actors;
  }

  function createBooking(actor: Actor): request.Test {
    return http().post(`${PREFIX}/bookings`).set('authorization', actor.token).send({
      providerId: actor.providerId,
      serviceId: actor.serviceId,
      addressId: actor.addressId,
      scheduledStart: actor.start,
      scheduledEnd: actor.end,
    });
  }

  it('havuz boyutunun üzerinde eşzamanlı, çakışmayan rezervasyon 5xx üretmez', async () => {
    // Havuzdan fazlası bilinçli seçilir: hata ancak uçuştaki istek sayısı havuz
    // boyutuna ulaştığında ortaya çıkıyordu.
    const concurrency = poolMax + 4;
    const actors = await setupActors(concurrency, false);
    await clearRateLimits(redis);

    const responses = await Promise.all(actors.map((actor) => createBooking(actor)));
    const statuses = responses.map((response) => response.status);

    // Tek bir 5xx bile regresyondur: çakışmayan rezervasyonlar birbirini düşüremez.
    expect(statuses.filter((status) => status >= 500)).toEqual([]);
    expect(statuses.filter((status) => status === 201)).toHaveLength(concurrency);

    const created = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM bookings`,
    );
    expect(Number(created.rows[0]?.count)).toBe(concurrency);
  });

  it('aynı sağlayıcı ve aynı aralığa eşzamanlı istekte tam olarak bir rezervasyon oluşur', async () => {
    const concurrency = poolMax + 4;
    const actors = await setupActors(concurrency, true);
    await clearRateLimits(redis);

    const responses = await Promise.all(actors.map((actor) => createBooking(actor)));
    const statuses = responses.map((response) => response.status);

    expect(statuses.filter((status) => status >= 500)).toEqual([]);
    // Doğruluğun kaynağı DB constraint'idir: kazanan bir tane, kalanı çakışma.
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(concurrency - 1);

    const overlapping = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM bookings a
      JOIN bookings b
        ON a.provider_id = b.provider_id
       AND a.id < b.id
       AND a.scheduled_start < b.scheduled_end
       AND b.scheduled_start < a.scheduled_end
      WHERE a.status <> 'CANCELLED' AND b.status <> 'CANCELLED'
    `);
    expect(Number(overlapping.rows[0]?.count)).toBe(0);
  });
});
