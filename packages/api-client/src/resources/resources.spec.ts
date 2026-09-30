import { vi } from 'vitest';
import { createApiClient } from '../client';
import { ApiError } from '../errors';
import { bookingsApi } from './bookings';
import { documentsApi, putToSignedUrl, sha256Hex } from './documents';
import { providersApi } from './providers';
import { requestsApi } from './requests';
import { safetyApi } from './safety';

function client(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  const api = createApiClient({
    getIdToken: async () => 'tok',
    fetch: fetchMock as unknown as typeof fetch,
  });
  const last = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    return { url, init, headers: new Headers(init.headers) };
  };
  return { api, last };
}

const notFound = (code: string) => ({ error: { code, message: 'yok' } });

describe('bookingsApi', () => {
  it('ödeme yoksa (404 NOT_FOUND) null döner; diğer hatalar fırlatılır', async () => {
    await expect(bookingsApi(client(404, notFound('NOT_FOUND')).api).payment('b1')).resolves.toBe(
      null,
    );
    await expect(
      bookingsApi(client(403, notFound('FORBIDDEN')).api).payment('b1'),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('ödeme yetkilendirmesi boş gövde + çağıranın Idempotency-Key’i ile gider', async () => {
    const { api, last } = client(201, {});
    await bookingsApi(api).authorizePayment('b/1', 'key-1');
    const { url, init, headers } = last();
    expect(url).toBe('/api/v1/bookings/b%2F1/payment');
    expect(init.body).toBe('{}');
    expect(headers.get('Idempotency-Key')).toBe('key-1');
  });

  it('iptal gerekçesi boşsa gövdeye yazılmaz', async () => {
    const { api, last } = client(200, {});
    await bookingsApi(api).cancel('b1', undefined, 'k');
    expect(last().init.body).toBe('{}');
    await bookingsApi(api).cancel('b1', 'Plan değişti', 'k2');
    expect(last().init.body).toBe('{"reason":"Plan değişti"}');
  });
});

describe('safetyApi', () => {
  it('oturum henüz yoksa null döner', async () => {
    const { api } = client(404, notFound('SAFETY_SESSION_NOT_FOUND'));
    await expect(safetyApi(api).sessionForBooking('b1')).resolves.toBeNull();
  });

  it('panik Idempotency-Key taşımaz (Redis kesintisi paniği bloklamamalı)', async () => {
    const { api, last } = client(201, {});
    await safetyApi(api).panic('s1', 'THREAT');
    expect(last().headers.has('Idempotency-Key')).toBe(false);
    expect(last().init.body).toBe('{"category":"THREAT"}');
  });
});

describe('requestsApi', () => {
  it('eşleştirme çağıranın anahtarıyla gönderilir', async () => {
    const { api, last } = client(201, {});
    await requestsApi(api).match('r1', 'match-key');
    expect(last().url).toBe('/api/v1/booking-requests/r1/match');
    expect(last().headers.get('Idempotency-Key')).toBe('match-key');
  });
});

describe('providersApi', () => {
  it('yazma uçları yalnızca /providers/me altındadır; silmede yol parçası kodlanır', async () => {
    const { api, last } = client(200, {});
    await providersApi(api).removeServiceArea('a/1');
    expect(last().url).toBe('/api/v1/providers/me/service-areas/a%2F1');
    expect(last().init.method).toBe('DELETE');
  });

  it('müsaitlik aralığı from/to sorgusuyla okunur', async () => {
    const { api, last } = client(200, []);
    await providersApi(api).availability('2026-10-12T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
    const url = new URL(last().url, 'http://x');
    expect(url.pathname).toBe('/api/v1/providers/me/availability');
    expect(url.searchParams.get('from')).toBe('2026-10-12T00:00:00.000Z');
    expect(url.searchParams.get('to')).toBe('2026-10-19T00:00:00.000Z');
  });

  it('yetkinlik seviye ile eklenir', async () => {
    const { api, last } = client(201, []);
    await providersApi(api).addSkill('sk-1', 'EXPERT');
    expect(last().init.body).toBe('{"skillId":"sk-1","level":"EXPERT"}');
  });
});

describe('bookingsApi.confirm', () => {
  it('sağlayıcı onayı Idempotency-Key taşır', async () => {
    const { api, last } = client(201, {});
    await bookingsApi(api).confirm('b1', 'k-1');
    expect(last().url).toBe('/api/v1/bookings/b1/confirm');
    expect(last().headers.get('Idempotency-Key')).toBe('k-1');
  });
});

describe('kanıt yükleme', () => {
  it('imzalı URL’e yükleme kimlik başlığı taşımaz, yalnızca içerik tipini gönderir', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const file = new Blob(['foto'], { type: 'image/jpeg' });
    await putToSignedUrl(
      'https://storage.googleapis.com/b/k?X-Goog-Signature=s',
      file,
      'image/jpeg',
      fetchMock as unknown as typeof fetch,
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(init.method).toBe('PUT');
    expect(headers.get('Content-Type')).toBe('image/jpeg');
    expect(headers.has('Authorization')).toBe(false);
    expect(headers.has('X-Firebase-AppCheck')).toBe(false);
    expect(init.credentials).toBe('omit');
  });

  it('storage reddi UPLOAD_FAILED olarak döner', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(
      putToSignedUrl('/u', new Blob(['x']), 'image/png', fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'UPLOAD_FAILED', status: 403 });
  });

  it('SHA-256 özeti hex üretilir', async () => {
    await expect(sha256Hex(new Blob(['abc']))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('confirm istemci özetini gövdede gönderir', async () => {
    const { api, last } = client(201, {});
    await documentsApi(api).confirm('d1', 'ab'.repeat(32));
    expect(last().url).toBe('/api/v1/documents/d1/confirm');
    expect(JSON.parse(last().init.body as string)).toEqual({ sha256: 'ab'.repeat(32) });
  });
});
