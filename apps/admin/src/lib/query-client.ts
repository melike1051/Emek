import { ApiError } from '@emek/api-client';
import { QueryCache, QueryClient, MutationCache } from '@tanstack/react-query';

/**
 * Yeniden deneme yalnızca geçici hatalarda (ağ, 429, 503) — 4xx iş hataları tekrar denenmez.
 * Mutasyonlar **hiç** otomatik tekrar denenmez: yan etkili komut kullanıcı eylemiyle tekrarlanır
 * ve aynı `Idempotency-Key`'i taşır.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  return error instanceof ApiError ? error.isRetryable : false;
}

export function createQueryClient(onUnauthenticated: () => void): QueryClient {
  const handle = (error: unknown) => {
    if (error instanceof ApiError && error.isUnauthenticated) onUnauthenticated();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError: handle }),
    mutationCache: new MutationCache({ onError: handle }),
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 30_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
