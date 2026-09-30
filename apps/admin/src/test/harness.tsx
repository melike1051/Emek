import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { MockAuthAdapter } from '@/lib/auth/mock-adapter';
import { ClientProviders } from '@/providers/AppProviders';
import { SessionGate } from '@/components/SessionGate';

export { navigation, router } from './navigation-mock';

type Handler = (
  method: string,
  body: unknown,
  url: URL,
  headers: Headers,
) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export const apiError = (status: number, code: string, message: string) =>
  json({ error: { code, message, requestId: 'req-1' } }, status);

export interface Call {
  method: string;
  path: string;
  url: URL;
  body: unknown;
  headers: Headers;
}

/** Sahte backend: `"POST /payments/p1/release"` ya da `"/ops/health"` (her metot) anahtarıyla. */
export function mockBackend(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const url = new URL(input, 'http://localhost');
    const path = url.pathname.replace('/api/v1', '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init.headers);
    calls.push({ method, path, url, body, headers });
    const handler = routes[`${method} ${path}`] ?? routes[path];
    if (!handler) return apiError(404, 'NOT_FOUND', 'yok');
    return handler(method, body, url, headers);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    find: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}

export function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

export const ADMIN_SESSION = {
  userId: 'op-1',
  roles: ['ADMIN'],
  status: 'ACTIVE',
  registered: true,
};
export const SUPPORT_SESSION = { ...ADMIN_SESSION, roles: ['SUPPORT'] };

/** Ekranı gerçek oturum kapısının arkasında render eder (rol kontrolü dahil). */
export function renderScreen(ui: ReactNode, { signedIn = true } = {}) {
  const adapter = new MockAuthAdapter(
    memoryStorage(signedIn ? { 'emek.mock-token': 'mock:op' } : {}),
  );
  return {
    adapter,
    ...render(
      <ClientProviders auth={adapter}>
        <SessionGate>{ui}</SessionGate>
      </ClientProviders>,
    ),
  };
}

export const page = <T,>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor });
