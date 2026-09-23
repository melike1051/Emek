/**
 * Faz 14 — `ENGINE_CIRCUIT_OPEN` bozulma nedeni.
 *
 * `HttpMatchingClient`'a devre kesici eklendi (EXP-007 §S-11): motor art arda
 * düştüğünde core bir süre **hiç çağrı yapmaz**. Bu durum `ENGINE_UNAVAILABLE`
 * olarak kaydedilseydi, bir olay sırasında en çok işe yarayan ayrım kaybolurdu:
 *
 *   - `ENGINE_UNAVAILABLE`  → motora gidildi, ulaşılamadı (motorun sorunu).
 *   - `ENGINE_CIRCUIT_OPEN` → motora **hiç gidilmedi**, core'un koruması konuşuyor.
 *
 * İkisi aynı satıra yazılsaydı "AI servisi ne sıklıkla düşüyor" grafiği, aslında
 * core'un beklemeyi kestiği süreleri de motor kesintisi gibi sayardı ve kimse
 * doğru yere bakmazdı. Ayrıca kesicinin gerçekten devreye girip girmediği
 * `matching_runs` üzerinden sorgulanamazdı — devre açılırken bir kez log yazılır,
 * sonraki 30 saniye boyunca hiç yazılmaz.
 *
 * Enum'a **ekleme** yapılır; mevcut değerler ve satırlar değişmez.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE matching_degraded_reason ADD VALUE IF NOT EXISTS 'ENGINE_CIRCUIT_OPEN';
  `);
};

exports.down = () => {
  // PostgreSQL enum değeri **düşürmeye izin vermez**; tipi yeniden yaratmak,
  // bu değeri taşıyan tarihsel `matching_runs` satırlarını ya silmeyi ya da
  // yeniden etiketlemeyi gerektirirdi. Ar-Ge kaydı geriye dönük değiştirilmez
  // (ADR-0012): geri alma bilinçli olarak **no-op**'tur.
};
