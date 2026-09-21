import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { BookingsService } from '../../src/bookings/bookings.service';
import type { BookingStatus } from '../../src/bookings/state/booking-status';
import { PREFIX, bearer } from './test-app';

/**
 * Safety integration testleri ve EXP-004 gecikme ölçümü için ortak fixture'lar.
 *
 * Rezervasyon **gerçek geçiş yolundan** hedef duruma getirilir (sistem adımları
 * `advanceBySystem`, kullanıcı adımları HTTP): durumu SQL ile yazmak, testin state
 * machine'i atlamasına yol açardı.
 */

/** Hizmet noktası: fixture adresinin koordinatı. */
export const HOME = { latitude: 40.9909, longitude: 29.0303 };
/** ~1,1 km kuzeyi: kesin dışarıda. Bu noktaya/noktadan 6 sn'de gidilemez. */
export const AWAY = { latitude: 41.0009, longitude: 29.0303 };
/** Sınırın iki yanı (yarıçap 150 m, bant 15 m): ~400 m, ~200 m dışarıda; ~100 m içeride. */
export const FAR = { latitude: 40.9945, longitude: 29.0303 };
export const OUT_NEAR = { latitude: 40.9927, longitude: 29.0303 };
export const IN_NEAR = { latitude: 40.9918, longitude: 29.0303 };

export interface SampleInput {
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  capturedAt?: Date;
  isMockLocation?: boolean;
}

export interface SafetyFixture {
  customerToken: string;
  providerToken: string;
  strangerToken: string;
  customerId: string;
  providerId: string;
  bookingId: string;
}

/** Fixture fonksiyonları; uygulama ve havuz geç bağlanır (beforeAll sonrası). */
export function safetyFixtures(getApp: () => INestApplication, getPool: () => Pool) {
  const http = (): request.Agent => request(getApp().getHttpServer());

  async function register(subject: string): Promise<string> {
    const response = await http()
      .post(`${PREFIX}/auth/session`)
      .set('authorization', bearer(subject))
      .expect(201);
    return response.body.userId as string;
  }

  async function grant(userId: string, role: 'ADMIN' | 'SUPPORT'): Promise<void> {
    await getPool().query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [userId, role]);
  }

  /** Rezervasyonu **gerçek geçiş yolundan** hedef duruma getirir. */
  async function setup(seed: string, status: BookingStatus): Promise<SafetyFixture> {
    const customerId = await register(`sf-customer-${seed}`);
    const providerId = await register(`sf-provider-${seed}`);
    await register(`sf-stranger-${seed}`);
    const customerToken = bearer(`sf-customer-${seed}`);
    const providerToken = bearer(`sf-provider-${seed}`);
    const strangerToken = bearer(`sf-stranger-${seed}`);

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
      .send({ city: 'İstanbul', district: 'Kadıköy', line: 'Test Sokak No 1', ...HOME })
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
    start.setUTCHours(10);
    const end = new Date(start.getTime() + 2 * 3600 * 1000);

    const booking = await http()
      .post(`${PREFIX}/bookings`)
      .set('authorization', customerToken)
      .send({
        providerId,
        serviceId: services.body[0].id as string,
        addressId: address.body.id as string,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
      })
      .expect(201);
    const bookingId = booking.body.id as string;

    const fixture = {
      customerToken,
      providerToken,
      strangerToken,
      customerId,
      providerId,
      bookingId,
    };
    await advance(fixture, status);
    return fixture;
  }

  async function advance(fixture: SafetyFixture, status: BookingStatus): Promise<void> {
    const bookings = getApp().get(BookingsService);
    const current = async (): Promise<BookingStatus> =>
      (
        await getPool().query<{ status: BookingStatus }>(
          `SELECT status FROM bookings WHERE id = $1`,
          [fixture.bookingId],
        )
      ).rows[0]!.status;

    const path: BookingStatus[] = [
      'REQUESTED',
      'MATCHED',
      'PROVIDER_PENDING',
      'CONFIRMED',
      'PAYMENT_AUTHORIZED',
      'SCHEDULED',
      'PROVIDER_ARRIVING',
      'CHECKED_IN',
      'IN_PROGRESS',
      'CHECKED_OUT',
    ];
    const from = path.indexOf(await current());
    const to = path.indexOf(status);

    for (const next of path.slice(from + 1, to + 1)) {
      if (next === 'CONFIRMED') {
        await http()
          .post(`${PREFIX}/bookings/${fixture.bookingId}/confirm`)
          .set('authorization', fixture.providerToken)
          .expect(201);
      } else if (
        ['MATCHED', 'PROVIDER_PENDING', 'PAYMENT_AUTHORIZED', 'SCHEDULED'].includes(next)
      ) {
        await bookings.advanceBySystem({ bookingId: fixture.bookingId, to: next });
      } else {
        await http()
          .post(`${PREFIX}/bookings/${fixture.bookingId}/transitions`)
          .set('authorization', fixture.providerToken)
          .send({ to: next })
          .expect(201);
      }
    }
  }

  async function sessionOf(bookingId: string): Promise<Record<string, unknown>> {
    const result = await getPool().query(
      `SELECT * FROM safety_sessions WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [bookingId],
    );
    return result.rows[0] as Record<string, unknown>;
  }

  async function events(
    sessionId: string,
  ): Promise<{ event_type: string; source: string; details: Record<string, unknown> }[]> {
    const result = await getPool().query(
      `SELECT event_type, source, details FROM safety_events WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    );
    return result.rows;
  }

  /** İstemci saati: her örnek bir öncekinden 6 sn sonra; şimdiden biraz önce başlar. */
  function clock(startOffsetSeconds = -110, spacingSeconds = 6): () => Date {
    let current = Date.now() + startOffsetSeconds * 1000;
    return () => {
      current += spacingSeconds * 1000;
      return new Date(current);
    };
  }

  function batch(firstSequence: number, next: () => Date, inputs: SampleInput[]) {
    return {
      samples: inputs.map((input, index) => ({
        sequence: firstSequence + index,
        capturedAt: (input.capturedAt ?? next()).toISOString(),
        latitude: input.latitude ?? HOME.latitude,
        longitude: input.longitude ?? HOME.longitude,
        accuracyMeters: input.accuracyMeters ?? 10,
        ...(input.isMockLocation !== undefined ? { isMockLocation: input.isMockLocation } : {}),
      })),
    };
  }

  function send(sessionId: string, token: string, body: unknown): request.Test {
    return http()
      .post(`${PREFIX}/safety/sessions/${sessionId}/telemetry`)
      .set('authorization', token)
      .send(body as object);
  }

  return { http, register, grant, setup, advance, sessionOf, events, clock, batch, send };
}
