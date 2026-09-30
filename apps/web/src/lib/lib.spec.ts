import { renderHook } from '@testing-library/react';
import { useIdempotencyKey } from './use-idempotency-key';
import { ApiError, createApiClient } from '@emek/api-client';
import { vi } from 'vitest';
import { buildMockToken, MockAuthAdapter } from './auth/mock-adapter';
import { firebaseAuthMessage, normalizeTrPhone } from './auth/phone';
import { safeNextPath } from './auth/redirect';
import { parseWebEnv } from './env';
import { invalidFields, toDisplayError } from './errors';
import { CATALOG_STALE_MS, createQueryClient, shouldRetry } from './query-client';
import { bootstrapSession, defaultHome, onboardingRedirect, type Session } from './session';

describe('normalizeTrPhone', () => {
  it.each([
    ['0532 111 22 33', '+905321112233'],
    ['532 111 2233', '+905321112233'],
    ['+90 (532) 111-22-33', '+905321112233'],
    ['905321112233', '+905321112233'],
  ])('%s → %s', (input, expected) => expect(normalizeTrPhone(input)).toBe(expected));

  it.each(['0212 111 22 33', '12345', '+15551112233', '05321112233x', ''])(
    '%s reddedilir',
    (input) => expect(normalizeTrPhone(input)).toBeNull(),
  );

  it('bilinmeyen Firebase kodu genel mesaja düşer (ham metin sızmaz)', () => {
    expect(firebaseAuthMessage('auth/internal-error')).toBe(
      'Giriş yapılamadı. Lütfen tekrar deneyin.',
    );
    expect(firebaseAuthMessage('auth/invalid-verification-code')).toBe('Doğrulama kodu hatalı.');
  });
});

describe('safeNextPath — açık yönlendirme engeli', () => {
  it.each([
    [null, '/'],
    ['/randevular/42?tab=odeme', '/randevular/42?tab=odeme'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['/giris?next=/x', '/'],
    ['/ok\nSet-Cookie', '/'],
  ])('%s → %s', (input, expected) => expect(safeNextPath(input)).toBe(expected));
});

describe('parseWebEnv', () => {
  const firebase = {
    NEXT_PUBLIC_FIREBASE_API_KEY: 'k',
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'd',
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'p',
    NEXT_PUBLIC_FIREBASE_APP_ID: 'a',
  };

  it('mock mod production build ile başlamaz', () => {
    expect(() => parseWebEnv({ NEXT_PUBLIC_AUTH_MODE: 'mock' }, 'production')).toThrow(
      /production/,
    );
  });

  it('firebase modunda eksik yapılandırma reddedilir', () => {
    expect(() => parseWebEnv({ NEXT_PUBLIC_AUTH_MODE: 'firebase' }, 'production')).toThrow(/eksik/);
  });

  it('geçersiz mod reddedilir', () => {
    expect(() => parseWebEnv({ NEXT_PUBLIC_AUTH_MODE: 'none' }, 'development')).toThrow();
  });

  it('varsayılan firebase; App Check anahtarı boşsa null', () => {
    expect(
      parseWebEnv({ ...firebase, NEXT_PUBLIC_APP_CHECK_SITE_KEY: '' }, 'production'),
    ).toMatchObject({
      authMode: 'firebase',
      appCheckSiteKey: null,
      firebase: { apiKey: 'k', projectId: 'p' },
    });
  });
});

describe('MockAuthAdapter', () => {
  it('backend MockTokenVerifier biçiminde token üretir ve sağlıksız kimliği reddeder', () => {
    expect(buildMockToken('dev-1', '+905321112233')).toBe('mock:dev-1:phone=+905321112233');
    expect(() => buildMockToken('a:b')).toThrow();
    expect(() => buildMockToken('')).toThrow();
  });

  it('giriş/çıkış dinleyicilere bildirilir', async () => {
    const store = new Map<string, string>();
    const adapter = new MockAuthAdapter({
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    });
    const events: boolean[] = [];
    const unsubscribe = adapter.subscribe((signedIn) => events.push(signedIn));
    adapter.signIn('dev-1');
    await expect(adapter.getIdToken()).resolves.toBe('mock:dev-1');
    await adapter.signOut();
    await expect(adapter.getIdToken()).resolves.toBeNull();
    unsubscribe();
    adapter.signIn('dev-2');
    expect(events).toEqual([false, true, false]);
  });
});

describe('shouldRetry', () => {
  it('yalnızca geçici hatalar ve en fazla iki kez', () => {
    const transient = new ApiError(503, { code: 'SERVICE_DEGRADED', message: 'x' });
    const business = new ApiError(409, { code: 'BOOKING_CONFLICT', message: 'x' });
    expect(shouldRetry(0, transient)).toBe(true);
    expect(shouldRetry(2, transient)).toBe(false);
    expect(shouldRetry(0, business)).toBe(false);
    expect(shouldRetry(0, new Error('bilinmeyen'))).toBe(false);
  });
});

describe('errors', () => {
  it('ApiError mesajını ve referansını taşır; diğer hatalarda ham metin gösterilmez', () => {
    expect(
      toDisplayError(new ApiError(409, { code: 'X', message: 'Güvenli', requestId: 'r' })),
    ).toEqual({
      message: 'Güvenli',
      requestId: 'r',
    });
    expect(
      toDisplayError(new Error('TypeError: cannot read x of undefined')).message,
    ).not.toContain('TypeError');
  });

  it('VALIDATION_FAILED alan adlarını backend biçiminden (details.fields) çıkarır', () => {
    const error = new ApiError(400, {
      code: 'VALIDATION_FAILED',
      message: 'İstek doğrulanamadı.',
      details: {
        fields: [
          'displayName must be longer than or equal to 2 characters',
          'experienceYears must not be greater than 80',
          42,
        ],
      },
    });
    expect(invalidFields(error)).toEqual(['displayName', 'experienceYears']);
    expect(
      invalidFields(new ApiError(409, { code: 'X', message: 'x', details: { fields: ['a b'] } })),
    ).toEqual([]);
    expect(invalidFields(new ApiError(400, { code: 'VALIDATION_FAILED', message: 'x' }))).toEqual(
      [],
    );
  });
});

describe('session', () => {
  const customer = {
    userId: 'u',
    displayName: 'Ayşe',
    preferences: {},
    createdAt: '',
    updatedAt: '',
  };
  const provider = {
    userId: 'u',
    displayName: 'Ayşe',
    bio: null,
    experienceYears: null,
    ratingAvg: null,
    ratingCount: 0,
    maxDailyBookings: 3,
    state: 'DRAFT' as const,
    createdAt: '',
    updatedAt: '',
  };
  const base: Session = { userId: 'u', roles: ['CUSTOMER'], customer: null, provider: null };

  it('bootstrapSession: PROVIDER rolü yoksa /providers/me hiç çağrılmaz (backend 403 döner)', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/auth/session')
        ? Response.json({ userId: 'u', roles: ['CUSTOMER'], status: 'ACTIVE', registered: true })
        : url.endsWith('/customers/me')
          ? Response.json(customer)
          : Response.json({ error: { code: 'FORBIDDEN', message: 'x' } }, { status: 403 }),
    );
    const api = createApiClient({
      getIdToken: async () => 't',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(bootstrapSession(api)).resolves.toEqual({ ...base, customer, provider: null });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/providers/me'))).toBe(false);
  });

  it('bootstrapSession: oturumu kurar, eksik profil (PROFILE_NOT_FOUND) null olur', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/session')) {
        return Response.json({
          userId: 'u',
          roles: ['CUSTOMER', 'PROVIDER'],
          status: 'ACTIVE',
          registered: true,
        });
      }
      if (url.endsWith('/customers/me')) return Response.json(customer);
      return Response.json(
        { error: { code: 'PROFILE_NOT_FOUND', message: 'Profil bulunamadı.' } },
        { status: 404 },
      );
    });
    const api = createApiClient({
      getIdToken: async () => 't',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(bootstrapSession(api)).resolves.toEqual({
      ...base,
      roles: ['CUSTOMER', 'PROVIDER'],
      customer,
      provider: null,
    });
  });

  it('bootstrapSession: profil dışı hatalar yutulmaz', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/auth/session')
        ? Response.json({ userId: 'u', roles: ['CUSTOMER'], status: 'ACTIVE', registered: false })
        : Response.json({ error: { code: 'SERVICE_DEGRADED', message: 'x' } }, { status: 503 }),
    );
    const api = createApiClient({
      getIdToken: async () => 't',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(bootstrapSession(api)).rejects.toMatchObject({ code: 'SERVICE_DEGRADED' });
  });

  it('onboardingRedirect', () => {
    expect(onboardingRedirect(base, '/randevular')).toBe('/rol-sec');
    expect(onboardingRedirect(base, '/rol-sec')).toBeNull();
    expect(onboardingRedirect({ ...base, customer }, '/panel')).toBe('/');
    expect(onboardingRedirect({ ...base, customer }, '/rol-sec')).toBeNull(); // ikinci profil eklenebilir
    expect(onboardingRedirect({ ...base, customer, provider }, '/rol-sec')).toBeNull(); // çıkışı RoleSelect yönetir
    expect(onboardingRedirect({ ...base, provider }, '/panel/hizmetler')).toBeNull();
  });

  it('defaultHome: yalnızca sağlayıcıysa panel', () => {
    expect(defaultHome({ ...base, provider })).toBe('/panel');
    expect(defaultHome({ ...base, customer, provider })).toBe('/');
  });
});

describe('useIdempotencyKey', () => {
  it('aynı gövdede aynı anahtar, gövde değişince yeni anahtar, başarıda yenilenir', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const first = result.current.current('{"rating":4}');
    // Kayıp yanıt sonrası aynı gövdeyle tekrar: backend kaydı tekrar oynatır.
    expect(result.current.current('{"rating":4}')).toBe(first);
    // Kullanıcı düzeltti: aynı anahtar farklı gövdeyle IDEMPOTENCY_KEY_REUSED alırdı.
    const edited = result.current.current('{"rating":5}');
    expect(edited).not.toBe(first);
    result.current.rotate();
    expect(result.current.current('{"rating":5}')).not.toBe(edited);
  });
});

describe('createQueryClient', () => {
  it('katalog sorguları uzun, diğerleri varsayılan tazelikte', () => {
    const client = createQueryClient(() => undefined);
    expect(client.getQueryDefaults(['catalog', 'services']).staleTime).toBe(CATALOG_STALE_MS);
    expect(client.getQueryDefaults(['bookings']).staleTime).toBeUndefined();
  });
});
