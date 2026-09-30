import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { MockAuthAdapter } from '@/lib/auth/mock-adapter';
import { ClientProviders } from '@/providers/AppProviders';

export { navigation, router } from './navigation-mock';

type Handler = (method: string, body: unknown) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export const PROFILE_NOT_FOUND = () =>
  json({ error: { code: 'PROFILE_NOT_FOUND', message: 'Profil bulunamadı.' } }, 404);

/** Sahte backend: `"POST /customers/profile"` ya da `"/users/me"` (her metot) anahtarıyla. */
export function mockBackend(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = new URL(url, 'http://localhost').pathname.replace('/api/v1', '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: new Headers(init.headers) });
    const handler = routes[`${method} ${path}`] ?? routes[path];
    if (!handler) return json({ error: { code: 'NOT_FOUND', message: 'yok' } }, 404);
    return handler(method, body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

export function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

export function renderApp(ui: ReactNode, { signedIn = true } = {}) {
  const adapter = new MockAuthAdapter(
    memoryStorage(signedIn ? { 'emek.mock-token': 'mock:test-user' } : {}),
  );
  return { adapter, ...render(<ClientProviders auth={adapter}>{ui}</ClientProviders>) };
}

export const SESSION = { userId: 'u-1', roles: ['CUSTOMER'], status: 'ACTIVE', registered: false };
export const PROVIDER_SESSION = { ...SESSION, roles: ['CUSTOMER', 'PROVIDER'] };
/** Gerçek backend: PROVIDER rolü olmayana `/providers/me` 403 döner. */
export const FORBIDDEN = () =>
  json({ error: { code: 'FORBIDDEN', message: 'Bu işlem için yetkiniz yok.' } }, 403);
export const CUSTOMER = {
  userId: 'u-1',
  displayName: 'Ayşe Nur',
  preferences: {},
  createdAt: '',
  updatedAt: '',
};
export const PROVIDER = {
  userId: 'u-1',
  displayName: 'Hatice Yılmaz',
  bio: null,
  experienceYears: 4,
  ratingAvg: null,
  ratingCount: 0,
  maxDailyBookings: 3,
  state: 'DRAFT',
  createdAt: '',
  updatedAt: '',
};
