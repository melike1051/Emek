import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { UnitOfWork } from '../database/unit-of-work';
import { AppConfigService } from '../config/app-config.service';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import { AUDIT_ARCHIVE, type AuditArchive } from './audit-archive.port';

export interface AuditVerificationResult {
  status: 'OK' | 'BROKEN';
  /** Bu turda doğrulanan satır sayısı. */
  rowsVerified: number;
  /** Doğrulanmış son satırın id'si; hiç satır yoksa null. */
  verifiedThroughId: string | null;
  /** Kopukluk bulunduysa ilk bozuk satırın id'si. */
  brokenAtId: string | null;
  /** Bu turda arşive yazılan parçanın anahtarı; yazım olmadıysa null. */
  exportedStorageKey: string | null;
}

interface CheckpointRow {
  verified_through_id: string;
  verified_hash: string;
  status: string;
}

interface VerifyRangeRow {
  last_verified_id: string | null;
  last_verified_hash: string | null;
  rows_verified: number;
  broken_at_id: string | null;
}

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_value: unknown;
  new_value: unknown;
  ip_address: string | null;
  request_id: string | null;
  created_at: Date;
  prev_hash: string | null;
  hash: string;
}

/**
 * Periyodik audit hash zinciri doğrulaması (ADR-0013 §8, T-36).
 *
 * Zincir **tamper-evident**'tır: yazarken kendini korur ama kopukluk ancak birisi
 * doğruladığında görünür. Bu servis o "birisi"dir.
 *
 * Doğrulama **artımlıdır**: her tur son checkpoint'ten devam eder, o checkpoint'in
 * hash'ini beklenen `prev_hash` olarak kullanır. Böylece hem yeni satırlar hem de
 * "zaten doğrulanmış" bir geçmişin yeniden yazılması yakalanır — ikinci durumda
 * beklenen `prev_hash` artık tutmaz.
 *
 * Doğrulama hiçbir audit satırını **değiştirmez**; yalnızca `audit_chain_checkpoints`
 * ve `audit_exports`'a ekleme yapar. Bu iki tablo da append-only trigger'ıyla korunur.
 */
@Injectable()
export class AuditVerificationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly config: AppConfigService,
    @Inject(AUDIT_ARCHIVE) private readonly archive: AuditArchive,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Bir doğrulama turu çalıştırır.
   *
   * Kopukluk bulunduğunda **istisna fırlatmaz**: bulgu kayda geçer ve dönen
   * sonuçta görünür. Fırlatmak, zamanlayıcının bir sonraki turu atlamasına ve
   * bulgunun yalnızca log'da kalmasına yol açardı; kopukluk kalıcı bir olgudur,
   * geçici bir hata değil.
   */
  async verifyOnce(): Promise<AuditVerificationResult> {
    const checkpoint = await this.latestCheckpoint();

    // Kopuk bir zincir kendiliğinden düzelmez: operatör inceleyip yeni bir
    // başlangıç noktası belirlemeden ilerlemek, bozuk aralığı sessizce atlamak olur.
    if (checkpoint !== null && checkpoint.status === 'BROKEN') {
      return {
        status: 'BROKEN',
        rowsVerified: 0,
        verifiedThroughId: checkpoint.verified_through_id,
        brokenAtId: checkpoint.verified_through_id,
        exportedStorageKey: null,
      };
    }

    const fromId =
      checkpoint === null ? '1' : (BigInt(checkpoint.verified_through_id) + 1n).toString();
    const expectedPrev = checkpoint === null ? null : checkpoint.verified_hash;
    const limit = this.config.env.AUDIT_VERIFICATION_BATCH_SIZE;

    const rows = await this.uow.query<VerifyRangeRow>(
      `SELECT * FROM audit_chain_verify_range($1::bigint, $2::char(64), $3::int)`,
      [fromId, expectedPrev, limit],
    );

    const result = rows[0];
    if (result === undefined) {
      throw new Error('audit_chain_verify_range sonuç döndürmedi');
    }

    // Yeni satır yok: yazacak bir şey olmadığı için checkpoint de yazılmaz.
    // Her turda aynı noktayı tekrar kaydetmek tabloyu gürültüyle doldururdu.
    if (result.rows_verified === 0 && result.broken_at_id === null) {
      return {
        status: 'OK',
        rowsVerified: 0,
        verifiedThroughId: checkpoint?.verified_through_id ?? null,
        brokenAtId: null,
        exportedStorageKey: null,
      };
    }

    const broken = result.broken_at_id !== null;
    const verifiedThroughId = result.last_verified_id ?? checkpoint?.verified_through_id ?? null;
    const verifiedHash = result.last_verified_hash ?? checkpoint?.verified_hash ?? null;

    let exportedStorageKey: string | null = null;

    // Yalnızca **doğrulanmış** aralık arşivlenir: bozuk bir parçayı "kanıt" diye
    // değişmez depolamaya yazmak, kanıtı değersizleştirir.
    if (
      !broken &&
      this.config.env.AUDIT_EXPORT_ENABLED &&
      verifiedThroughId !== null &&
      result.rows_verified > 0
    ) {
      exportedStorageKey = await this.exportRange(fromId, verifiedThroughId);
    }

    await this.uow.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO audit_chain_checkpoints
           (verified_through_id, verified_hash, rows_verified, broken_at_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          // Kopukluk ilk satırdaysa doğrulanmış hiçbir satır yoktur; checkpoint yine
          // de yazılır ki bulgu kalıcı olsun. Bu durumda sınır bir önceki turunkidir.
          verifiedThroughId ?? checkpoint?.verified_through_id ?? '0',
          verifiedHash ?? checkpoint?.verified_hash ?? '0'.repeat(64),
          result.rows_verified,
          result.broken_at_id,
          broken ? 'BROKEN' : 'OK',
        ],
      );
    });

    if (broken) {
      this.logger.error(
        { brokenAtId: result.broken_at_id, verifiedThroughId },
        'Audit hash zinciri kopuk: denetim izi değiştirilmiş olabilir',
      );
    }

    return {
      status: broken ? 'BROKEN' : 'OK',
      rowsVerified: result.rows_verified,
      verifiedThroughId,
      brokenAtId: result.broken_at_id,
      exportedStorageKey,
    };
  }

  /** En son doğrulama checkpoint'i; hiç doğrulama yapılmadıysa null. */
  async latestCheckpoint(): Promise<CheckpointRow | null> {
    const rows = await this.uow.query<CheckpointRow>(
      `SELECT verified_through_id, verified_hash, status
         FROM audit_chain_checkpoints ORDER BY id DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /**
   * Doğrulanmış aralığı arşive yazar ve kaydını tutar.
   *
   * Parça, satırların kanonik JSON temsilidir; özeti `audit_exports.sha256`'ya
   * yazılır. Arşiv nesnesi ile veritabanı kaydı birbirini doğrular: biri
   * değiştirilirse özet tutmaz.
   */
  private async exportRange(fromId: string, throughId: string): Promise<string> {
    const rows = await this.uow.query<AuditRow>(
      `SELECT id, actor_user_id, action, entity_type, entity_id, old_value, new_value,
              host(ip_address) AS ip_address, request_id, created_at, prev_hash, hash
         FROM audit_logs
        WHERE id >= $1::bigint AND id <= $2::bigint
        ORDER BY id`,
      [fromId, throughId],
    );

    // Satır başına bir JSON (JSONL): parça sonradan akış olarak okunabilir ve
    // tek bir satırın değişmesi özeti bozar.
    const body = rows
      .map((row) =>
        JSON.stringify({
          id: row.id,
          actorUserId: row.actor_user_id,
          action: row.action,
          entityType: row.entity_type,
          entityId: row.entity_id,
          oldValue: row.old_value,
          newValue: row.new_value,
          ipAddress: row.ip_address,
          requestId: row.request_id,
          createdAt: row.created_at.toISOString(),
          prevHash: row.prev_hash,
          hash: row.hash,
        }),
      )
      .join('\n');

    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    const storageKey = `audit-exports/${fromId}-${throughId}-${sha256.slice(0, 16)}.jsonl`;
    const retentionUntil = new Date(
      Date.now() + this.config.env.AUDIT_EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.archive.put({ storageKey, body, retentionUntil });

    await this.uow.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO audit_exports
           (from_audit_id, through_audit_id, row_count, sha256, storage_key, retention_until)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [fromId, throughId, rows.length, sha256, storageKey, retentionUntil],
      );
    });

    return storageKey;
  }
}
