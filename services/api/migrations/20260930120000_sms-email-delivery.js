/**
 * R-77 — SMS / e-posta teslimatı. Worker artık `PUSH`, `SMS` ve `EMAIL` işlerini alır; bekleyen
 * iş index'i bu kanalları kapsar. (`IN_APP` teslim edilmez; eski `IN_APP` işleri
 * 20260929120000'de kapatıldı.)
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_notification_due;
    CREATE INDEX idx_notification_due ON notification_jobs (next_attempt_at)
      WHERE status = 'PENDING' AND channel IN ('PUSH', 'SMS', 'EMAIL');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_notification_due;
    CREATE INDEX idx_notification_due ON notification_jobs (next_attempt_at)
      WHERE status = 'PENDING' AND channel = 'PUSH';
  `);
};
