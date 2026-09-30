/**
 * İstemci yapılandırması. `NEXT_PUBLIC_*` değişkenleri build anında gömülür; bu yüzden her biri
 * `process.env.X` biçiminde **literal** okunmalıdır (dinamik erişim gömülmez).
 */
export type AuthMode = 'firebase' | 'mock';

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

export interface AdminEnv {
  authMode: AuthMode;
  firebase: FirebaseWebConfig | null;
  /** reCAPTCHA Enterprise site anahtarı; yoksa App Check başlatılmaz (backend dev'de kapalı). */
  appCheckSiteKey: string | null;
}

export function parseAdminEnv(
  raw: Record<string, string | undefined>,
  nodeEnv: string | undefined,
): AdminEnv {
  const authMode = (raw.NEXT_PUBLIC_AUTH_MODE ?? 'firebase') as AuthMode;
  if (authMode !== 'firebase' && authMode !== 'mock') {
    throw new Error(`NEXT_PUBLIC_AUTH_MODE geçersiz: ${String(authMode)}`);
  }
  // ADR-0016/0024: mock giriş yalnızca geliştirme build'inde var olabilir.
  if (authMode === 'mock' && nodeEnv === 'production') {
    throw new Error('NEXT_PUBLIC_AUTH_MODE=mock production build ile kullanılamaz');
  }

  let firebase: FirebaseWebConfig | null = null;
  if (authMode === 'firebase') {
    const {
      NEXT_PUBLIC_FIREBASE_API_KEY,
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      NEXT_PUBLIC_FIREBASE_APP_ID,
    } = raw;
    if (
      !NEXT_PUBLIC_FIREBASE_API_KEY ||
      !NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ||
      !NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
      !NEXT_PUBLIC_FIREBASE_APP_ID
    ) {
      throw new Error('Firebase web yapılandırması eksik (NEXT_PUBLIC_FIREBASE_*)');
    }
    firebase = {
      apiKey: NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      appId: NEXT_PUBLIC_FIREBASE_APP_ID,
    };
  }

  return { authMode, firebase, appCheckSiteKey: raw.NEXT_PUBLIC_APP_CHECK_SITE_KEY || null };
}

let cached: AdminEnv | undefined;

export function adminEnv(): AdminEnv {
  cached ??= parseAdminEnv(
    {
      NEXT_PUBLIC_AUTH_MODE: process.env.NEXT_PUBLIC_AUTH_MODE,
      NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
      NEXT_PUBLIC_APP_CHECK_SITE_KEY: process.env.NEXT_PUBLIC_APP_CHECK_SITE_KEY,
    },
    process.env.NODE_ENV,
  );
  return cached;
}
