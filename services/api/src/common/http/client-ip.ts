import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';

/** Web/admin Next.js proxy'sinin çözdüğü tarayıcı adresi (R-107, ADR-0026). */
export const PROXY_CLIENT_IP_HEADER = 'x-emek-client-ip';
/** Başlığın gerçekten bizim proxy'mizden geldiğini kanıtlayan paylaşılan sır. */
export const PROXY_AUTH_HEADER = 'x-emek-proxy-auth';

/**
 * İstemci adresinin **güvenilmez başlıklara güvenmeden** çözümlenmesi (R-53).
 *
 * `X-Forwarded-For` istemci tarafından serbestçe yazılabilir. Express'in
 * `trust proxy` ayarı naif biçimde açıldığında (`true`) listenin **en soldaki**
 * girdisi alınır; bu girdiyi saldırgan kendisi yazar ve her istekte farklı bir
 * değer vererek IP bazlı oran sınırını tamamen atlatır. Ayarı hiç açmamak ise
 * Cloud Run arkasında ters uca düşürür: tüm istekler tek bir ön uç adresinden
 * gelir ve sınır global bir kovaya dönüşür.
 *
 * Çözüm, güvenilen proxy **sayısını** yapılandırmaktır. Zincir sağdan sola
 * okunur: en sağdaki girdiler bizim kendi altyapımızın eklediği, dolayısıyla
 * güvenilebilir hop'lardır. `hopCount` kadar hop atlandığında kalan ilk adres,
 * güvenilen son proxy'nin **gerçekten gördüğü** eş adresidir — saldırgan bunu
 * yazamaz. Solundaki her şey istemci uydurması olabilir ve yok sayılır.
 *
 * `hopCount` semantiği Express'in `trust proxy: <n>` semantiğiyle aynıdır:
 * adres listesi `[socket, ...xff.reverse()]` kurulur ve `n`. eleman seçilir.
 * `n = 0` → yalnızca soket adresi; hiçbir başlığa güvenilmez.
 *
 * Yapılandırma yanlışsa (zincir beklenenden kısaysa) **fail-closed** davranılır:
 * soket adresine düşülür. Yanlış yapılandırma en kötü ihtimalle sınırı daraltır,
 * saldırgan kontrolündeki bir değere genişletmez.
 */
export function resolveClientIp(
  request: Request,
  hopCount: number,
  webProxySecret?: string,
): string {
  const proxied = proxiedClientIp(request, webProxySecret);
  if (proxied !== null) {
    return proxied;
  }

  const socketIp = request.socket?.remoteAddress ?? 'unknown';

  if (hopCount <= 0) {
    return normalize(socketIp);
  }

  const raw = request.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  const forwarded = header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  // Sağdan sola: [soket, en sağdaki xff, ...]. `hopCount` kadar güvenilen hop atlanır.
  const addresses = [socketIp, ...forwarded.reverse()];
  const candidate = addresses[hopCount];

  // Zincir beklenenden kısa: yapılandırma ile gerçek topoloji uyuşmuyor. Kalan
  // girdiler istemci tarafından yazılmış olabilir, güvenilmez.
  if (candidate === undefined) {
    return normalize(socketIp);
  }

  return normalize(candidate);
}

/**
 * Web/admin tarayıcı trafiği (R-107, ADR-0026). Bu istekler Next.js aynı-origin proxy'sinden
 * geçer; `X-Forwarded-For` zinciri bir hop uzar ve tek `TRUSTED_PROXY_HOP_COUNT` hem bu yola
 * hem doğrudan gelen mobil istemciye uyamaz. Proxy tarayıcı adresini kendi hop sayısıyla çözer
 * ve ayrı bir başlıkla iletir; başlığa **yalnızca** paylaşılan sır eşleşirse güvenilir.
 * Sır tanımsız/yanlışsa ya da adres geçerli tek bir IP değilse `null` → hop sayısı yolu
 * (fail-closed: en kötü ihtimal Next'in çıkış adresi kovası, saldırganın seçtiği bir kova değil).
 */
function proxiedClientIp(request: Request, secret: string | undefined): string | null {
  if (secret === undefined || secret.length === 0) {
    return null;
  }
  const auth = request.headers[PROXY_AUTH_HEADER];
  const value = request.headers[PROXY_CLIENT_IP_HEADER];
  if (typeof auth !== 'string' || typeof value !== 'string') {
    return null;
  }
  // Özetler sabit uzunluktadır: karşılaştırma sırrın uzunluğunu da sızdırmaz.
  const expected = createHash('sha256').update(secret).digest();
  const actual = createHash('sha256').update(auth).digest();
  if (!timingSafeEqual(expected, actual)) {
    return null;
  }
  const address = normalize(value);
  return isIP(address) === 0 ? null : address;
}

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) sayaç anahtarında IPv4 ile aynı kovaya düşmeli. */
function normalize(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    return 'unknown';
  }
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}
