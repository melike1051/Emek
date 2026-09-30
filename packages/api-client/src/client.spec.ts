import { vi } from 'vitest';
import { buildUrl, createApiClient } from './client';
import { ApiError } from './errors';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(
  response: Response | Error,
  tokens: { id?: string | null; appCheck?: string | null } = {},
) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const client = createApiClient({
    getIdToken: async () => (tokens.id === undefined ? 'id-token' : tokens.id),
    getAppCheckToken: async () => tokens.appCheck ?? null,
    fetch: fetchMock as unknown as typeof fetch,
    generateIdempotencyKey: () => 'generated-key',
  });
  const lastCall = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    return { url, init, headers: new Headers(init.headers) };
  };
  return { client, fetchMock, lastCall };
}

describe('buildUrl', () => {
  it('aynı-origin göreli yol üretir ve boş sorgu parametrelerini atar', () => {
    expect(buildUrl('', '/bookings', { status: 'CONFIRMED', cursor: undefined, q: '' })).toBe(
      '/api/v1/bookings?status=CONFIRMED',
    );
  });

  it("'/' ile başlamayan yolu reddeder", () => {
    expect(() => buildUrl('', 'bookings')).toThrow();
  });
});

describe('createApiClient', () => {
  it('Bearer ve App Check başlıklarını ekler, çerez göndermez', async () => {
    const { client, lastCall } = setup(jsonResponse(200, { ok: true }), { appCheck: 'ac-token' });
    await expect(client.get('/users/me')).resolves.toEqual({ ok: true });
    const { url, init, headers } = lastCall();
    expect(url).toBe('/api/v1/users/me');
    expect(headers.get('Authorization')).toBe('Bearer id-token');
    expect(headers.get('X-Firebase-AppCheck')).toBe('ac-token');
    expect(init.credentials).toBe('omit');
  });

  it('token yoksa Authorization başlığı göndermez', async () => {
    const { client, lastCall } = setup(jsonResponse(200, {}), { id: null });
    await client.get('/services');
    expect(lastCall().headers.has('Authorization')).toBe(false);
  });

  it('idempotencyKey: true → üretilmiş anahtar; string → verilen anahtar aynen', async () => {
    const { client, lastCall } = setup(jsonResponse(201, {}));
    await client.post('/bookings', { a: 1 }, { idempotencyKey: true });
    expect(lastCall().headers.get('Idempotency-Key')).toBe('generated-key');
    expect(lastCall().headers.get('Content-Type')).toBe('application/json');
    expect(lastCall().init.body).toBe('{"a":1}');

    const second = setup(jsonResponse(201, {}));
    await second.client.post('/bookings', {}, { idempotencyKey: 'user-action-1' });
    expect(second.lastCall().headers.get('Idempotency-Key')).toBe('user-action-1');
  });

  it('backend hata gövdesini ApiError olarak taşır (mesaj uydurulmaz)', async () => {
    const { client } = setup(
      jsonResponse(409, {
        error: {
          code: 'BOOKING_CONFLICT',
          message: 'Seçilen zaman aralığı artık uygun değil.',
          requestId: 'r1',
        },
      }),
    );
    const error = await client.post('/bookings', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'BOOKING_CONFLICT',
      message: 'Seçilen zaman aralığı artık uygun değil.',
      requestId: 'r1',
      isRetryable: false,
    });
  });

  it('401 UNAUTHENTICATED yeniden giriş gerektirir', async () => {
    const { client } = setup(
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
    );
    const error = (await client.get('/users/me').catch((e: unknown) => e)) as ApiError;
    expect(error.isUnauthenticated).toBe(true);
  });

  it('sözleşme dışı hata gövdesi (ör. proxy HTML sayfası) güvenli genel hataya dönüşür', async () => {
    const { client } = setup(new Response('<html>Bad Gateway</html>', { status: 502 }));
    const error = (await client.get('/users/me').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('UNEXPECTED_RESPONSE');
    expect(error.status).toBe(502);
    expect(error.message).not.toContain('html');
  });

  it('ağ hatası tekrar denenebilir NETWORK_ERROR olur', async () => {
    const { client } = setup(new TypeError('Failed to fetch'));
    const error = (await client.get('/users/me').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.isRetryable).toBe(true);
  });

  it('iptal edilen istek AbortError olarak yayılır', async () => {
    const { client } = setup(new DOMException('aborted', 'AbortError'));
    await expect(client.get('/users/me')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('204 gövdesiz yanıtı undefined döner', async () => {
    const { client } = setup(new Response(null, { status: 204 }));
    await expect(client.delete('/addresses/x')).resolves.toBeUndefined();
  });
});
