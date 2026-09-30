import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { AppConfigService } from '../common/config/app-config.service';
import { POSTGRES_POOL } from '../common/database/database.tokens';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import {
  EMAIL_SENDER,
  SMS_SENDER,
  type EmailSender,
  type MessageOutcome,
  type SmsSender,
} from './message-senders';
import { renderEmail, renderSms } from './message-templates';
import { PUSH_SENDER, type PushSender } from './push-sender';
import { RELEVANT_BOOKING_STATUSES, renderPush } from './push-templates';

/** Sahiplenme kirası: bu süre içinde bitmeyen iş (çöken instance) tekrar alınabilir. */
const LEASE_SECONDS = 120;
const BATCH_SIZE = 50;
/**
 * Aynı anda teslim edilen iş sayısı. Bir iş en çok `MAX_DEVICES_PER_USER` cihaza **paralel**
 * gönderir ve her gönderim ≤ 10 sn sürer: en kötü tur ≈ (50 / 10) × 10 sn = 50 sn — kiranın
 * yarısından az. Sıralı döngü bozuk FCM'de kirayı aşıp işi ikinci instance'a verirdi.
 */
const JOB_CONCURRENCY = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ClaimedJob {
  id: string;
  channel: 'PUSH' | 'SMS' | 'EMAIL';
  recipient_user_id: string;
  template_key: string;
  template_data: Record<string, unknown>;
  attempts: number;
  /**
   * Sahiplenme kirası; sonuç yazımı yalnız kira hâlâ bizdeyse uygulanır. Metin olarak taşınır:
   * JS `Date` mikrosaniyeyi keser ve eşitlik hiç tutmazdı.
   */
  lease: string;
}

interface Contact {
  phone: string | null;
  email: string | null;
}

interface Device {
  id: string;
  user_id: string;
  token: string;
}

export interface DeliveryTickResult {
  sent: number;
  failed: number;
  retried: number;
}

/**
 * Bildirim teslimatı (Faz 16, R-77). `notification_jobs` kuyruğundaki zamanı gelmiş işleri
 * kanalına göre gönderir: `PUSH` alıcının cihazlarına, `SMS` telefonuna, `EMAIL` adresine.
 * İletişim bilgisi gönderim anında `users`'tan okunur; silinmiş (anonimleştirilmiş) hesaba, askıdaki hesaba ya da
 * bilgisi olmayana gönderilmez (`NO_CONTACT`). Geçersiz numara/adres iletişim bilgisini silmez.
 *
 * - **Sahiplenme:** tek ifadede `FOR UPDATE SKIP LOCKED` + `next_attempt_at` kirası — iki instance
 *   aynı işi aynı anda almaz; çöken instance'ın işi kira dolunca tekrar alınır. Sonuç yazımı
 *   `next_attempt_at = kira` ile korunur: kirası elinden alınmış tur başkasının sonucunu ezmez.
 *   (En az bir kez
 *   teslim: kira içinde gönderip `SENT` yazamadan çökülürse bildirim bir kez daha gidebilir —
 *   bilgilendirme bildirimi için kabul edilen takas; para hareketi değildir.)
 * - **Sonuç:** en az bir cihaza gittiyse `SENT`; hiç cihaz yoksa `FAILED` (`NO_DEVICE`, tekrar
 *   denenmez); geçici hatada üstel geri çekilme, `NOTIFICATION_MAX_ATTEMPTS` sonrası `FAILED`.
 *   Geçersiz token'ın cihaz kaydı silinir.
 * - **Bayatlık (R-114):** durum-duyarlı şablonda randevu artık ilgili durumda değilse iş
 *   gönderilmeden `FAILED` (`STALE`) olur.
 *
 * Başlatma: `NOTIFICATION_DELIVERY_ENABLED=true` (varsayılan kapalı).
 */
@Injectable()
export class NotificationDeliveryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.env.NOTIFICATION_DELIVERY_ENABLED) {
      this.logger.info('Bildirim teslimatı devre dışı (NOTIFICATION_DELIVERY_ENABLED=false)');
      return;
    }
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error: unknown) =>
          this.logger.error({ err: error }, 'Bildirim teslimat turu başarısız'),
        )
        .finally(() => this.schedule());
    }, this.config.env.NOTIFICATION_DELIVERY_INTERVAL_MS);
    this.timer.unref();
  }

  /** Tek teslimat turu. Testler doğrudan çağırır. */
  async tick(): Promise<DeliveryTickResult> {
    const result: DeliveryTickResult = { sent: 0, failed: 0, retried: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      const claimed = await this.pool.query<ClaimedJob>(
        `UPDATE notification_jobs
            SET next_attempt_at = now() + make_interval(secs => $1)
          WHERE id IN (
            SELECT id FROM notification_jobs
             WHERE status = 'PENDING' AND channel IN ('PUSH', 'SMS', 'EMAIL')
               AND next_attempt_at <= now()
             ORDER BY next_attempt_at
             LIMIT $2
             FOR UPDATE SKIP LOCKED)
          RETURNING id, channel, recipient_user_id, template_key, template_data, attempts,
                    next_attempt_at::text AS lease`,
        [LEASE_SECONDS, BATCH_SIZE],
      );
      if (claimed.rows.length === 0) return result;

      const recipientsOf = (channels: ClaimedJob['channel'][]) => [
        ...new Set(
          claimed.rows
            .filter((job) => channels.includes(job.channel))
            .map((job) => job.recipient_user_id),
        ),
      ];
      // Kanal başına tek sorgu: cihazlar ve iletişim bilgileri (iş başına sorgu yok).
      const devices = await this.pool.query<Device>(
        `SELECT id, user_id, token FROM user_devices WHERE user_id = ANY($1::uuid[])`,
        [recipientsOf(['PUSH'])],
      );
      const contactRows = await this.pool.query<Contact & { id: string }>(
        // Askıya alınmış ve silinmiş hesaba SMS/e-posta gitmez (deny by default).
        // TODO(verify): e-posta doğrulanmışlığı (`email_verified`) saklanmıyor; adres Firebase
        // token'ından gelir. İçerik sabit ve PII'siz olduğundan aktarıcı riski yok.
        `SELECT id, phone, email FROM users
          WHERE id = ANY($1::uuid[]) AND status NOT IN ('DELETED', 'SUSPENDED')`,
        [recipientsOf(['SMS', 'EMAIL'])],
      );
      const contacts = new Map(contactRows.rows.map((row) => [row.id, row]));
      const byUser = new Map<string, Device[]>();
      for (const device of devices.rows) {
        byUser.set(device.user_id, [...(byUser.get(device.user_id) ?? []), device]);
      }

      // Durum-duyarlı işlerin randevu durumları, yine tek sorguda (R-114).
      const staleCheckIds = [
        ...new Set(
          claimed.rows
            .filter((job) => RELEVANT_BOOKING_STATUSES[job.template_key] !== undefined)
            .map((job) => job.template_data['bookingId'])
            .filter((id): id is string => typeof id === 'string' && UUID.test(id)),
        ),
      ];
      const statuses = new Map<string, string>();
      if (staleCheckIds.length > 0) {
        const rows = await this.pool.query<{ id: string; status: string }>(
          `SELECT id, status FROM bookings WHERE id = ANY($1::uuid[])`,
          [staleCheckIds],
        );
        for (const row of rows.rows) statuses.set(row.id, row.status);
      }

      const queue = [...claimed.rows];
      const workers = Array.from({ length: Math.min(JOB_CONCURRENCY, queue.length) }, async () => {
        for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
          const outcome = this.isStale(job, statuses)
            ? await this.fail(job, 'STALE')
            : job.channel === 'PUSH'
              ? await this.deliver(job, byUser.get(job.recipient_user_id) ?? [])
              : await this.deliverMessage(job, contacts.get(job.recipient_user_id));
          if (outcome !== null) result[outcome] += 1;
        }
      });
      await Promise.all(workers);
      return result;
    } finally {
      this.running = false;
    }
  }

  private isStale(job: ClaimedJob, statuses: ReadonlyMap<string, string>): boolean {
    const relevant = RELEVANT_BOOKING_STATUSES[job.template_key];
    if (relevant === undefined) return false;
    const bookingId = job.template_data['bookingId'];
    const status = typeof bookingId === 'string' ? statuses.get(bookingId) : undefined;
    // Randevu bulunamadıysa (bozuk kimlik) karar `renderPush`'a kalır: UNRENDERABLE.
    return status !== undefined && !relevant.includes(status);
  }

  /** `null`: kira bu tur bitmeden başka bir instance'a geçti; sonuç onun. */
  private async deliver(
    job: ClaimedJob,
    devices: readonly Device[],
  ): Promise<keyof DeliveryTickResult | null> {
    const content = renderPush(job.template_key, job.template_data);
    if (content === null) {
      return this.fail(job, 'UNRENDERABLE');
    }
    if (devices.length === 0) {
      return this.fail(job, 'NO_DEVICE');
    }

    const outcomes = await Promise.all(
      devices.map((device) => this.sender.send(device.token, content)),
    );
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome !== 'INVALID_TOKEN') continue;
      const device = devices[index]!;
      // Token + sahip ile: aynı token bu arada başka hesaba taşındıysa (upsert aynı satırı
      // korur) yeni sahibin taze kaydı silinmez.
      await this.pool.query(
        `DELETE FROM user_devices WHERE id = $1 AND token = $2 AND user_id = $3`,
        [device.id, device.token, device.user_id],
      );
    }
    const delivered = outcomes.includes('SENT');
    const transient = outcomes.includes('TRANSIENT');
    const permanent = outcomes.includes('PERMANENT');

    return this.settleOutcome(job, delivered, transient, () =>
      permanent ? 'PROVIDER_REJECTED' : transient ? null : 'INVALID_TOKENS',
    );
  }

  /**
   * Ortak sonuç: gönderildi / geri çekil / kalıcı hata. `failReason` `null` ise hata yalnız
   * geçicidir ve deneme hakkı bitmiştir (`MAX_ATTEMPTS`).
   */
  private settleOutcome(
    job: ClaimedJob,
    delivered: boolean,
    transient: boolean,
    failReason: () => string | null,
  ): Promise<keyof DeliveryTickResult | null> {
    if (delivered) {
      return this.settle(
        job,
        `status = 'SENT', sent_at = now(), attempts = attempts + 1, last_error = NULL`,
        [],
        'sent',
      );
    }
    if (transient && job.attempts + 1 < this.config.env.NOTIFICATION_MAX_ATTEMPTS) {
      // Üstel geri çekilme: 30 sn, 1 dk, 2 dk, 4 dk …
      const backoffSeconds = 30 * 2 ** job.attempts;
      return this.settle(
        job,
        `attempts = attempts + 1, last_error = 'TRANSIENT',
         next_attempt_at = now() + make_interval(secs => $3)`,
        [backoffSeconds],
        'retried',
      );
    }
    return this.fail(job, failReason() ?? 'MAX_ATTEMPTS');
  }

  /** SMS / e-posta: tek alıcı adresi. */
  private async deliverMessage(
    job: ClaimedJob,
    contact: Contact | undefined,
  ): Promise<keyof DeliveryTickResult | null> {
    const isSms = job.channel === 'SMS';
    const content = isSms ? renderSms(job.template_key) : renderEmail(job.template_key);
    if (content === null || !UUID.test(String(job.template_data['bookingId']))) {
      return this.fail(job, 'UNRENDERABLE');
    }
    const address = isSms ? contact?.phone : contact?.email;
    if (address === null || address === undefined) {
      return this.fail(job, 'NO_CONTACT');
    }
    let outcome: MessageOutcome;
    try {
      outcome = isSms
        ? await this.sms.send(address, content as { text: string })
        : await this.email.send(address, content as { subject: string; text: string });
    } catch (error) {
      this.logger.warn(
        { jobId: job.id, err: error instanceof Error ? error.message : error },
        'Mesaj gönderilemedi',
      );
      outcome = 'TRANSIENT';
    }
    return this.settleOutcome(job, outcome === 'SENT', outcome === 'TRANSIENT', () =>
      outcome === 'INVALID_RECIPIENT'
        ? 'INVALID_RECIPIENT'
        : outcome === 'PERMANENT'
          ? 'PROVIDER_REJECTED'
          : null,
    );
  }

  private fail(job: ClaimedJob, reason: string): Promise<'failed' | null> {
    return this.settle(
      job,
      `status = 'FAILED', attempts = attempts + 1, last_error = $3`,
      [reason],
      'failed',
    );
  }

  /** Sonucu yalnız iş hâlâ bu turun kirasındaysa yazar ($1 = id, $2 = kira, $3… = ek). */
  private async settle<T extends keyof DeliveryTickResult>(
    job: ClaimedJob,
    set: string,
    params: unknown[],
    outcome: T,
  ): Promise<T | null> {
    const updated = await this.pool.query(
      `UPDATE notification_jobs SET ${set}
        WHERE id = $1 AND status = 'PENDING' AND next_attempt_at = $2::timestamptz`,
      [job.id, job.lease, ...params],
    );
    if (updated.rowCount === 0) {
      this.logger.warn({ jobId: job.id }, 'Bildirim işi kirası başka tura geçti; sonuç yazılmadı');
      return null;
    }
    return outcome;
  }
}
