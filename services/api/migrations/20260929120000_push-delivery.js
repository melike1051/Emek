/**
 * Faz 16 — push teslimatı (R-77) ve cihaz token'ları.
 *
 * `user_devices`: bir kullanıcının FCM kayıt token'ları (1-N). Token **cihaza** aittir, kişiye
 * değil: aynı telefonda başka hesapla giriş yapılınca token yeni kullanıcıya **taşınır**
 * (UNIQUE token + upsert) — önceki kullanıcıya bildirim gitmez. Token kişisel veri sayılır:
 * `last_seen_at` ile bayatlayan token'lar retention taramasında silinir, hesap anonimleştirilince
 * tüm token'ları silinir (data-retention-inventory.md).
 *
 * `notification_jobs.next_attempt_at`: geçici teslimat hatasında geri çekilme (backoff). İşler
 * yeniden denenene kadar kuyruğu tıkamaz; worker yalnız zamanı gelmiş işleri alır.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE device_platform AS ENUM ('IOS', 'ANDROID');

    CREATE TABLE user_devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id),
      token TEXT NOT NULL UNIQUE CHECK (length(token) BETWEEN 1 AND 4096),
      platform device_platform NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_user_devices_user ON user_devices (user_id);
    CREATE INDEX idx_user_devices_last_seen ON user_devices (last_seen_at);

    ALTER TABLE notification_jobs
      ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

    -- R-76 öncesi işler alıcı sütununda rezervasyon kimliği taşır: teslim edilemezler.
    -- Bekler hâlde kalırlarsa her teslimat turu onları yeniden tarar.
    UPDATE notification_jobs
       SET status = 'FAILED', last_error = 'LEGACY_R76'
     WHERE status = 'PENDING' AND channel <> 'PUSH';

    DROP INDEX IF EXISTS idx_notification_pending;
    CREATE INDEX idx_notification_due ON notification_jobs (next_attempt_at)
      WHERE status = 'PENDING' AND channel = 'PUSH';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_notification_due;
    CREATE INDEX idx_notification_pending ON notification_jobs (created_at)
      WHERE status = 'PENDING';
    ALTER TABLE notification_jobs DROP COLUMN IF EXISTS next_attempt_at;
    DROP TABLE IF EXISTS user_devices;
    DROP TYPE IF EXISTS device_platform;
  `);
};
