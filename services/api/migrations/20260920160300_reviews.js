/**
 * Karşılıklı değerlendirmeler.
 *
 * Değerlendirme, matching skorunun girdisidir (Faz 7): manipüle edilebilir bir review
 * tablosu doğrudan algoritmayı manipüle eder. Bu yüzden invariant'lar veritabanındadır:
 *
 * - Bir rezervasyon için **bir taraf bir kez** değerlendirme yazar.
 * - Yazan kişi değerlendirilen kişi olamaz (kendine puan yok).
 * - Puan aralığı sabittir.
 *
 * "Yalnızca tamamlanmış rezervasyon değerlendirilebilir" kuralı booking durumuna
 * bağlıdır ve serviste uygulanır: CHECK içinden başka tabloya bakılamaz.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      subject_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      rating SMALLINT NOT NULL,
      comment VARCHAR(2000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CHECK (rating >= 1 AND rating <= 5),
      CONSTRAINT reviews_not_self CHECK (author_user_id <> subject_user_id),
      -- Çift oy engeli: aynı rezervasyonda aynı yazarın ikinci puanı olamaz.
      CONSTRAINT reviews_one_per_author UNIQUE (booking_id, author_user_id)
    );

    CREATE INDEX idx_reviews_subject ON reviews (subject_user_id, created_at DESC);

    CREATE TRIGGER reviews_set_updated_at
      BEFORE UPDATE ON reviews
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS reviews;`);
};
