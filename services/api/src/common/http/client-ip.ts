import type { Request } from 'express';

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
export function resolveClientIp(request: Request, hopCount: number): string {
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

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) sayaç anahtarında IPv4 ile aynı kovaya düşmeli. */
function normalize(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    return 'unknown';
  }
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}
