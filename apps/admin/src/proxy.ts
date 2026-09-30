import { NextResponse, type NextRequest } from 'next/server';
import { forwardedClientIp } from './lib/client-ip';
import { buildCsp, createNonce } from './lib/csp';

const CLIENT_IP_HEADER = 'x-emek-client-ip';
const PROXY_AUTH_HEADER = 'x-emek-proxy-auth';
const MIN_SECRET_LENGTH = 32;

/**
 * Aynı-origin API proxy'si (ADR-0024 §5) ve istemci adresi (R-107, ADR-0026).
 *
 * Hedef **çalışma zamanında** `API_ORIGIN`'den okunur: `next.config` `rewrites()` derleme anında
 * çözülür ve container imajında derlemedeki değere (varsayılan `localhost:3000`, yani imajın
 * kendisi) kilitlenirdi. `next.config` rewrite'ı yalnız eşleşme dışı yerel `_dev` yolu içindir.
 *
 * Tarayıcının gönderdiği `X-Emek-*` başlıkları **her zaman** silinir. Sır tanımlıysa proxy
 * tarayıcı adresini kendi hop sayısıyla çözer ve sırla birlikte iletir; API başlığa yalnız
 * sır eşleşirse güvenir. Sır tanımsızsa (yerel geliştirme) hiçbir şey eklenmez.
 */
function forwardApi(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete(CLIENT_IP_HEADER);
  headers.delete(PROXY_AUTH_HEADER);

  const secret = process.env.WEB_PROXY_SECRET;
  // API 32 karakterden kısa sırrı zaten kabul etmez (env şeması); göndermek yalnız sırrı taşır.
  if (secret && secret.length >= MIN_SECRET_LENGTH) {
    const hopCount = Number(process.env.CLIENT_IP_HOP_COUNT ?? '1');
    const address = forwardedClientIp(request.headers.get('x-forwarded-for'), hopCount);
    if (address !== null) {
      headers.set(CLIENT_IP_HEADER, address);
      headers.set(PROXY_AUTH_HEADER, secret);
    }
  }
  const target = new URL(
    request.nextUrl.pathname + request.nextUrl.search,
    process.env.API_ORIGIN ?? 'http://localhost:3000',
  );
  return NextResponse.rewrite(target, { request: { headers } });
}

/**
 * Sayfa istekleri: istek başına nonce'lu CSP (R-105). Next nonce'u istek başlığındaki CSP'den
 * okuyup kendi script'lerine uygular; aynı değer yanıta da yazılır.
 */
function withCsp(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export function proxy(request: NextRequest) {
  return request.nextUrl.pathname.startsWith('/api/') ? forwardApi(request) : withCsp(request);
}

export const config = {
  matcher: [
    // API; yerel mock depolama (`_dev/storage`, kanıt dosyası PUT'u) hariç: orada adres gerekmez
    // ve Proxy gövdeyi tamponladığı için büyük yüklemeleri boşuna belleğe alırdı.
    '/api/v1/((?!_dev/).*)',
    // Sayfalar; statik paketler ve `next/link` ön yüklemeleri hariç (HTML değil, nonce gerekmez).
    {
      source: '/((?!api/|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
