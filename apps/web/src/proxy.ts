import { NextResponse, type NextRequest } from 'next/server';
import { forwardedClientIp } from './lib/client-ip';

const CLIENT_IP_HEADER = 'x-emek-client-ip';
const PROXY_AUTH_HEADER = 'x-emek-proxy-auth';
const MIN_SECRET_LENGTH = 32;

/**
 * Aynı-origin API proxy'si için istemci adresi (R-107, ADR-0026). `rewrites`'tan önce çalışır;
 * burada ayarlanan istek başlıkları rewrite hedefine (core API) gider.
 *
 * Tarayıcının gönderdiği `X-Emek-*` başlıkları **her zaman** silinir. Sır tanımlıysa proxy
 * tarayıcı adresini kendi hop sayısıyla çözer ve sırla birlikte iletir; API başlığa yalnız
 * sır eşleşirse güvenir. Sır tanımsızsa (yerel geliştirme) hiçbir şey eklenmez.
 */
export function proxy(request: NextRequest) {
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
  return NextResponse.next({ request: { headers } });
}

// Yalnız API; yerel mock depolama (`_dev/storage`, kanıt dosyası PUT'u) hariç: orada adres
// gerekmez ve Proxy gövdeyi tamponladığı için büyük yüklemeleri boşuna belleğe alırdı.
export const config = { matcher: '/api/v1/((?!_dev/).*)' };
