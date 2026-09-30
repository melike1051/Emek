/**
 * Girişten sonra dönülecek yolu doğrular — açık yönlendirme (open redirect) engeli.
 * Yalnızca aynı origin'de, `/` ile başlayan ve `//` ya da `/\` olmayan göreli yollar kabul edilir.
 */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback;
  }
  // Kontrol karakteri (CR/LF vb.) içeren yol reddedilir.
  if ([...value].some((char) => char.charCodeAt(0) < 0x20)) return fallback;
  if (value.startsWith('/giris')) return fallback;
  return value;
}
