import { isIP } from 'node:net';

/**
 * Tarayıcı adresinin çözümü (R-107, ADR-0026). Core API ile **aynı** sağdan-sola hop
 * semantiği (`services/api/src/common/http/client-ip.ts`): en sağdaki girdiler kendi
 * altyapımızın eklediği güvenilir hop'lardır; solundakiler istemci uydurması olabilir.
 *
 * Proxy soket adresini göremez. Next, `X-Forwarded-For` yoksa soket adresini başlığa yazar
 * (`base-server`, `??=`); başlık varsa (Cloud Run ön ucu) önümüzdeki altyapının eklediği
 * girdi en sağdadır. `hopCount` bu yüzden "sağdan kaçıncı girdi"dir; 1 = en sağdaki.
 *
 * Zincir kısa, adres geçersiz ya da `hopCount < 1` ise `null`: proxy başlığı hiç eklemez ve
 * API kendi hop sayısı yoluna düşer (fail-closed — ortak kova, saldırganın seçtiği kova değil).
 */
export function forwardedClientIp(forwardedFor: string | null, hopCount: number): string | null {
  if (!Number.isInteger(hopCount) || hopCount < 1) return null;
  const chain = (forwardedFor ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const candidate = chain[chain.length - hopCount];
  if (candidate === undefined) return null;
  const address = candidate.startsWith('::ffff:') ? candidate.slice('::ffff:'.length) : candidate;
  return isIP(address) === 0 ? null : address;
}
