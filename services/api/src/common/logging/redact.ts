/**
 * Hassas alanların derin maskelenmesi.
 *
 * pino'nun `redact.paths` seçeneği joker karakter başına yalnızca **bir** seviye eşler
 * (`*.token` → `{a:{token}}` evet, `{a:{b:{token}}}` hayır). Log nesneleri iç içe
 * geçebildiği (ör. `err`, `payload.user.profile`) için maskeleme anahtar adına göre,
 * derinlik sınırıyla birlikte uygulanır.
 *
 * Kural: alan adı hassas listedeyse değer atılır. Liste
 * docs/architecture/coding-conventions.md §5 ile aynıdır.
 */

export const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  [
    'password',
    'passwd',
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'authorization',
    'cookie',
    'secret',
    'apikey',
    'privatekey',
    'otp',
    'otpcode',
    'nationalid',
    'tckn',
    'identityhash',
    'identity_hash',
    'cardnumber',
    'card_number',
    'pan',
    'cvv',
    'cvc',
    'iban',
  ].map((key) => key.toLowerCase()),
);

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 100;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Nesneyi kopyalayarak hassas alanları maskeler. Girdi değiştirilmez —
 * loglama, çağıranın verisini asla bozmamalı.
 */
export function maskSensitive(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => maskSensitive(item, depth + 1));
  }

  if (value instanceof Error) {
    // Error kendi alanlarını enumerable tutmaz; anlamlı alanlar açıkça taşınır.
    return {
      type: value.name,
      message: value.message,
      ...(value.stack !== undefined ? { stack: value.stack } : {}),
    };
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const masked: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    masked[key] = SENSITIVE_KEYS.has(key.toLowerCase())
      ? REDACTED
      : maskSensitive(child, depth + 1);
  }
  return masked;
}
