/**
 * Para minor unit **string** olarak gelir (BIGINT); `Number`'a çevrilmez — büyük tutarda
 * hassasiyet kaybı olurdu (Faz 5 review bulgusu M2). apps/web/src/lib/booking.ts ile aynı kural.
 */
export function formatMoney(minor: string, currency: string): string {
  if (!/^-?\d+$/.test(minor)) return `${minor} ${currency}`;
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0');
  const whole = BigInt(digits.slice(0, -2));
  const fraction = digits.slice(-2);
  const grouped = new Intl.NumberFormat('tr-TR').format(whole);
  const symbol = currency === 'TRY' ? '₺' : currency;
  return `${negative ? '-' : ''}${grouped},${fraction} ${symbol}`;
}

/** "150,50" / "150.5" / "150" → minor unit string; geçersizse `null`. Kuruş 2 haneyle sınırlı. */
export function parseMoneyToMinor(input: string): string | null {
  const match = /^(\d{1,17})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const minor = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '0').padEnd(2, '0'));
  return minor > 0n ? minor.toString() : null;
}

const DATE_TIME: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Istanbul',
};

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('tr-TR', DATE_TIME) : '—';
}

/** Kuyruk yaşı gibi süreler: "45 sn", "12 dk", "3 sa 5 dk", "2 gün". */
export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} sn`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} dk`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} sa ${minutes % 60} dk` : `${hours} sa`;
  return `${Math.floor(hours / 24)} gün`;
}

/** UUID'nin ilk bloğu — listelerde okunabilir kısa kimlik; tamamı `title`'da. */
export function shortId(id: string): string {
  return id.split('-')[0] ?? id;
}

// Backend `@IsUUID()` ile aynı: sürüm 1-8, RFC varyantı; aksi hâlde 400 VALIDATION_FAILED döner.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Kimlik filtresi: geçerli UUID değilse sorguya yazılmaz (backend `IsUUID` 400 döner). */
export function uuidOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return UUID.test(trimmed) ? trimmed : undefined;
}
