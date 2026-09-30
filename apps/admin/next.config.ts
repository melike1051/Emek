import path from 'node:path';
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

// Content-Security-Policy istek başına nonce'la `src/proxy.ts`'te üretilir (R-105, `src/lib/csp.ts`).

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Container imajı (infra/docker/Dockerfile.frontend): yalnız çalışma zamanı dosyaları. Monorepo
  // kökü izleme kökü olmazsa workspace paketleri (`@emek/ui`, `@emek/api-client`) eksik kalır.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  poweredByHeader: false,
  transpilePackages: ['@emek/ui', '@emek/api-client'],
  // API yönlendirmesi çalışma zamanında `src/proxy.ts`'tedir (ADR-0026 ek). Buradaki rewrite
  // yalnız geliştirmede, proxy eşleşmesi dışındaki yerel mock depolama (`/api/v1/_dev/*`) içindir.
  // Production'da yoktur: derleme anında çözülen hedef imajın kendisine (`localhost:3000`) döner
  // ve kimliksiz bir istek kendini sonsuz yönlendirirdi (Faz 17 review).
  async rewrites() {
    return isDev
      ? [{ source: '/api/v1/_dev/:path*', destination: `${apiOrigin}/api/v1/_dev/:path*` }]
      : [];
  },
  async headers() {
    return [
      {
        // Proxy'nin sayfa eşleşmesi dışında kalan yollar (ör. `/api/...` 404'leri) nonce'lu CSP
        // almaz; bunlar için script çalıştırmayan katı bir yedek (derinlemesine savunma).
        source: '/api/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" },
        ],
      },
      {
        source: '/:path*',
        headers: [
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
