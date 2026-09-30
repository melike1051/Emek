import type { NextConfig } from 'next';

/**
 * ADR-0024 §5: tarayıcı yalnızca kendi origin'indeki `/api/v1/*`'e konuşur; Next.js bunu
 * core API'ye iletir. Backend'de CORS açılmaz. `API_ORIGIN` yalnızca sunucu tarafında okunur.
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
 * CSP: Firebase Auth (telefon OTP) reCAPTCHA iframe'i ve Google kimlik uçları gerektirir.
 * TODO(faz-15/güvenlik-review): 'unsafe-inline' script yerine nonce tabanlı CSP.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval' " : ''}https://www.google.com https://www.gstatic.com https://apis.google.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://storage.googleapis.com",
  "font-src 'self'",
  // storage.googleapis.com: kanıt dosyası imzalı URL ile doğrudan GCS'ye yüklenir (bucket CORS'u
  // Terraform `web_origins`). Yerelde mock storage aynı-origin `/api/v1/_dev/storage`'dır.
  "connect-src 'self' https://storage.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebaseappcheck.googleapis.com https://content-firebaseappcheck.googleapis.com https://www.google.com",
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
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        ],
      },
      {
        // Oturum sonrası sayfalar (ad, adres) paylaşılan/tarayıcı cache'inde kalmaz; içerik-hash'li
        // `/_next/static` Next'in kendi `immutable` başlığıyla cache'lenmeye devam eder.
        source: '/((?!_next/static).*)',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

export default nextConfig;
