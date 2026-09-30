import { adminEnv } from '../env';
import type { AuthAdapter } from './adapter';
import { MockAuthAdapter } from './mock-adapter';

let adapter: Promise<AuthAdapter> | undefined;

/**
 * Tarayıcıda tekil adapter. Sunucu tarafında çağrılmaz (Firebase Auth istemci SDK'sıdır).
 * Firebase SDK'sı (~50 KB gzip) dinamik import ile yalnız firebase modunda yüklenir; mock modda
 * (yerel geliştirme, E2E) hiç indirilmez.
 */
export function getAuthAdapter(): Promise<AuthAdapter> {
  adapter ??= (async () => {
    const env = adminEnv();
    if (env.authMode === 'mock') return new MockAuthAdapter(window.sessionStorage);
    const { FirebaseAuthAdapter } = await import('./firebase-adapter');
    // parseAdminEnv, firebase modunda yapılandırmanın dolu olduğunu garanti eder.
    return new FirebaseAuthAdapter(env.firebase!, env.appCheckSiteKey);
  })();
  return adapter;
}
