/**
 * CRC32C (Castagnoli) — Cloud KMS bütünlük doğrulaması için (Faz 13).
 *
 * KMS, `data_crc32c` **gönderilmediğinde** yanıttaki `verified_data_crc32c`
 * alanını her zaman `false` döndürür: alan "istek doğrulandı mı" değil, "gönderilen
 * checksum teslim alındı mı" anlamına gelir. Yani checksum göndermeden yapılan bir
 * doğrulama kontrolü ya her zaman patlar ya da hiçbir şey ölçmez.
 *
 * Bağımlılık eklenmedi: polinom tablosu 15 satır ve bilinen test vektörleriyle
 * doğrulanabiliyor. (`@google-cloud/storage`'ın CRC32C'sini ödünç almak, kimlik
 * modülünü depolama paketine bağlardı.)
 */

const POLYNOMIAL = 0x82f63b78;

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ POLYNOMIAL : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

/** Verilen baytların CRC32C değeri (işaretsiz 32-bit). */
export function crc32c(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    // `!`: indis maskeyle 0-255 aralığına sabitlendi, tablo tam 256 elemanlı.
    crc = (crc >>> 8) ^ TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
