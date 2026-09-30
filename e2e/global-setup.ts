import { API_URL, clearRateLimits } from './support/seed';

/** Core API ayakta ve mock kimlik doğrulamasıyla mı? Değilse net bir hatayla dur. */
export default async function globalSetup(): Promise<void> {
  const health = await fetch(`${API_URL}/health/live`).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `Core API ${API_URL} adresinde yanıt vermiyor. Önce: npm run infra:up && npm run migrate:up && ` +
        `npm run seed:catalog --workspace=@emek/api && npm run dev --workspace=@emek/api`,
    );
  }
  await clearRateLimits();
  const probe = await fetch(`${API_URL}/auth/session`, {
    method: 'POST',
    headers: { authorization: 'Bearer mock:e2e-probe:phone=+905300000000' },
  });
  if (probe.status === 401) {
    throw new Error('Core API AUTH_PROVIDER=mock ile çalışmıyor; E2E yalnız mock kimlikle koşar.');
  }
}
