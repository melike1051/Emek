import { vi } from 'vitest';

export const router = {
  replace: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};
export const navigation = { pathname: '/', search: new URLSearchParams() };

/** `vi.mock('next/navigation', ...)` test dosyasında çağrılır (hoisting dosya başınadır). */
export const nextNavigationMock = {
  useRouter: () => router,
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.search,
};
