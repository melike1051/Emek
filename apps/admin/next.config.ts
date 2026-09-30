import type { NextConfig } from 'next';

/**
 * Operasyon uygulaması (ADR-0024 §1): ayrı dağıtım, ayrı origin. `apps/web` ile aynı-origin
 * proxy deseni — tarayıcı yalnızca kendi `/api/v1/*`'ine konuşur, backend'de CORS açılmaz.
 */
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3000';
const isDev = process.env.NODE_ENV !== 'production';

// Mock giriş production build'ine girmez: env.ts çalışma anında da reddeder, ama hata derleme
// sırasında (CI'da) görülsün diye burada da durulur.
if (!isDev && process.env.NEXT_PUBLIC_AUTH_MODE === 'mock') {
  throw new Error('NEXT_PUBLIC_AUTH_MODE=mock production build ile kullanılamaz.');
}

/** Yalnız production: yerel http geliştirmede HSTS tarayıcıyı localhost için kilitlerdi. */
const hsts = isDev
  ? []
  : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }];

/**
 * Web'den daha dar: kanıt dosyası yükleme/indirme yoktur (storage.googleapis.com yok), konum
 * izni istenmez. Firebase telefon OTP reCAPTCHA'sı ve kimlik uçları gerekir.
 * TODO(faz-15/güvenlik-review): 'unsafe-inline' script yerine nonce tabanlı CSP (web ile aynı).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval' " : ''}https://www.google.com https://www.gstatic.com https://apis.google.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebaseappcheck.googleapis.com https://content-firebaseappcheck.googleapis.com https://www.google.com",
  'frame-src https://www.google.com https://*.firebaseapp.com',
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@emek/ui', '@emek/api-client'],
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // frame-ancestors'u tanımayan eski tarayıcılar için.
          { key: 'X-Frame-Options', value: 'DENY' },
          ...hsts,
          // Operasyon URL'leri (kayıt kimlikleri) başka sitelere referrer olarak sızmaz.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        // Operasyon verisi cache'lenmez; `/_next/static` içerik-hash'li paketleri Next'in kendi
        // `immutable` başlığıyla cache'lenmeye devam eder.
        source: '/((?!_next/static).*)',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

export default nextConfig;
