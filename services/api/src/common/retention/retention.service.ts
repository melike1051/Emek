import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AppConfigService } from '../config/app-config.service';
import { UnitOfWork } from '../database/unit-of-work';
import { ROOT_LOGGER } from '../logging/logging.tokens';

export interface RetentionSweepResult {
  anonymizedUsers: number;
  processedEvents: number;
  deadLetterEvents: number;
  verificationAttempts: number;
  analyticsEvents: number;
}

/**
 * Saklama süresi dolmuş verinin **gerçekten** silinmesi (T-24, R-38).
 *
 * Belgelenmiş ama uygulanmayan bir saklama politikası, politika değildir. Bu
 * servis `docs/security/data-retention-inventory.md`'deki kuralların çalışan
 * karşılığıdır; süreler tek kaynaktan (env) gelir.
 *
 * Kapsam dışı bırakılanlar **bilinçlidir**:
 * - `audit_logs`: append-only ve hash zinciriyle korunur; silinmesi zinciri
 *   kırar. Denetim izinin saklama sınırı retention-locked arşivdedir (ADR-0013 §8).
 * - `bookings`, `payments`, `payment_events`, `disputes`: mali ve hukuki saklama
 *   yükümlülüğü altındadır. Kullanıcı anonimleştirilse bile bu kayıtlar kalır.
 * - `location_events`: kendi retention'ı `SafetyMaintenanceService`'tedir; oturum
 *   bazlı politika (panik/uyuşmazlık uzatması) orada yaşar ve iki yerden
 *   silinmesi yarış üretirdi.
 *
 * Her tur sınırlı sayıda satır işler: tek bir DELETE ile milyonlarca satır silmek
 * tabloyu kilitler ve transaction'ı şişirir.
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async sweep(): Promise<RetentionSweepResult> {
    const result: RetentionSweepResult = {
      anonymizedUsers: await this.anonymizeDeletedUsers(),
      processedEvents: await this.purgeByAge(
        'processed_events',
        'processed_at',
        this.config.env.RETENTION_PROCESSED_EVENT_DAYS,
      ),
      deadLetterEvents: await this.purgeResolvedDeadLetters(),
      verificationAttempts: await this.purgeByAge(
        'verification_attempts',
        'created_at',
        this.config.env.RETENTION_VERIFICATION_ATTEMPT_DAYS,
      ),
      analyticsEvents: await this.purgeExportedAnalytics(),
    };

    this.logger.info({ retention: result }, 'Retention taraması tamamlandı');
    return result;
  }

  /**
   * Kapatılmış hesabın kişisel verisini kaldırır (R-38).
   *
   * Satır **silinmez**: `bookings`, `payments` ve `audit_logs` ona atıfta bulunur
   * ve bunların saklanması gereklidir. Kaldırılan, kişiyi tanımlayan alanlardır —
   * iletişim bilgisi (zaten kapatmada boşaltıldı), görünen ad, biyografi ve adres
   * satırları. Geriye pseudonim bir kimlik referansı kalır.
   *
   * `users.id` korunur çünkü tekillik index'i ve tarihsel referanslar ona bağlıdır.
   */
  private async anonymizeDeletedUsers(): Promise<number> {
    const days = this.config.env.RETENTION_DELETED_USER_DAYS;
    const batch = this.config.env.RETENTION_BATCH_SIZE;

    return this.uow.withTransaction(async (client) => {
      const due = await client.query<{ id: string }>(
        `SELECT id FROM users
          WHERE deleted_at IS NOT NULL
            AND anonymized_at IS NULL
            AND deleted_at < now() - make_interval(days => $1::int)
          ORDER BY deleted_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [days, batch],
      );

      const ids = due.rows.map((row) => row.id);
      if (ids.length === 0) {
        return 0;
      }

      // Görünen ad tamamen kaldırılamaz (NOT NULL + boşluk CHECK'i): profil
      // satırını silmek ise geçmiş rezervasyonların sağlayıcı/müşteri bağlamını
      // koparırdı. Sabit bir pseudonim, ikisini de bozmadan kişiyi tanımlamaz.
      await client.query(
        `UPDATE customer_profiles
            SET display_name = 'Silinmiş kullanıcı', preferences = '{}'::jsonb
          WHERE user_id = ANY($1::uuid[])`,
        [ids],
      );

      await client.query(
        `UPDATE provider_profiles
            SET display_name = 'Silinmiş kullanıcı', bio = NULL
          WHERE user_id = ANY($1::uuid[])`,
        [ids],
      );

      // Adres satırı ve koordinat doğrudan kişiye ait konumdur. Şehir/ilçe
      // istatistiksel olarak kalır; `line` ve tam koordinat kaldırılır.
      await client.query(
        `UPDATE addresses
            SET line = 'anonim', label = NULL,
                latitude = round(latitude::numeric, 1)::double precision,
                longitude = round(longitude::numeric, 1)::double precision
          WHERE user_id = ANY($1::uuid[])`,
        [ids],
      );

      await client.query(`UPDATE users SET anonymized_at = now() WHERE id = ANY($1::uuid[])`, [
        ids,
      ]);

      for (const id of ids) {
        await this.audit.record(client, {
          action: AuditAction.USER_ANONYMIZED,
          entityType: 'user',
          entityId: id,
          newValue: { retentionDays: days },
        });
      }

      return ids.length;
    });
  }

  /** Çözülmüş dead-letter kayıtları; çözülmemişler operatör kuyruğudur ve silinmez. */
  private async purgeResolvedDeadLetters(): Promise<number> {
    const days = this.config.env.RETENTION_DEAD_LETTER_DAYS;
    const batch = this.config.env.RETENTION_BATCH_SIZE;

    const rows = await this.uow.query<{ id: string }>(
      `DELETE FROM dead_letter_events
        WHERE id IN (
          SELECT id FROM dead_letter_events
           WHERE resolved_at IS NOT NULL
             AND resolved_at < now() - make_interval(days => $1::int)
           ORDER BY resolved_at
           LIMIT $2
        )
        RETURNING id`,
      [days, batch],
    );
    return rows.length;
  }

  /**
   * Dışa aktarılmış analytics event'leri.
   *
   * Aktarılmamış satır **silinmez**: kanonik kopya BigQuery'dedir ve oraya hiç
   * ulaşmamış bir olayı burada silmek veriyi tamamen kaybetmek olurdu.
   */
  private async purgeExportedAnalytics(): Promise<number> {
    const days = this.config.env.RETENTION_ANALYTICS_EVENT_DAYS;
    const batch = this.config.env.RETENTION_BATCH_SIZE;

    const rows = await this.uow.query<{ id: string }>(
      `DELETE FROM analytics_events
        WHERE id IN (
          SELECT id FROM analytics_events
           WHERE exported_at IS NOT NULL
             AND created_at < now() - make_interval(days => $1::int)
           ORDER BY created_at
           LIMIT $2
        )
        RETURNING id`,
      [days, batch],
    );
    return rows.length;
  }

  /**
   * Yaşa göre toplu silme.
   *
   * Tablo ve sütun adları **sabit bir beyaz listeden** gelir (çağıranlar bu
   * dosyadadır); kullanıcı girdisi hiçbir biçimde tanımlayıcıya dönüşmez.
   */
  private async purgeByAge(
    table: 'processed_events' | 'verification_attempts',
    column: 'processed_at' | 'created_at',
    days: number,
  ): Promise<number> {
    const batch = this.config.env.RETENTION_BATCH_SIZE;

    if (table === 'processed_events') {
      const rows = await this.uow.query<{ event_id: string }>(
        `DELETE FROM processed_events
          WHERE (consumer, event_id) IN (
            SELECT consumer, event_id FROM processed_events
             WHERE processed_at < now() - make_interval(days => $1::int)
             ORDER BY processed_at
             LIMIT $2
          )
          RETURNING event_id`,
        [days, batch],
      );
      return rows.length;
    }

    // `table` ve `column` bu dosyadaki
    // sabit birleşim tiplerinden gelir (metot imzasına bakın); istek verisi buraya
    // hiçbir yoldan ulaşamaz. Değerler ($1, $2) parametreli geçirilir.
    // nosemgrep: emek-no-string-interpolated-sql
    const rows = await this.uow.query<{ id: string }>(
      `DELETE FROM ${table}
        WHERE id IN (
          SELECT id FROM ${table}
           WHERE ${column} < now() - make_interval(days => $1::int)
           ORDER BY ${column}
           LIMIT $2
        )
        RETURNING id`,
      [days, batch],
    );
    return rows.length;
  }
}
