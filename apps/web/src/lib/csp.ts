/**
 * Nonce tabanlı Content-Security-Policy (R-105, ADR-0024 §CSP). Nonce her sayfa isteğinde
 * `proxy.ts`'te üretilir; Next kendi script'lerine otomatik uygular (dinamik render şart —
 * kök layout `connection()` bekler). `'strict-dynamic'`: nonce'lu script'in yüklediği script'ler
 * (Firebase telefon OTP reCAPTCHA) güvenilir; CSP3 tarayıcıları alan adı listesini yok sayar, alan
 * adları yalnız eski tarayıcılar için yedektir. Satır içi `style` öznitelikleri yaygın olduğu için
 * `style-src` `'unsafe-inline'` kalır — XSS'in asıl vektörü script'tir.
 */
export function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    // Geliştirmede React hata yığınlarını eval ile kurar; production'da gerekmez.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''} https://www.google.com https://www.gstatic.com https://apis.google.com`,
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
}

/** Kriptografik olarak rastgele, istek başına tek kullanımlık nonce (128 bit). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
