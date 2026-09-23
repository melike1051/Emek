import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { POSTGRES_POOL } from '../common/database/database.tokens';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import { AppConfigService } from '../common/config/app-config.service';
import { BIGQUERY_PORT, type AnalyticsEventRow, type BigQueryPort } from './bigquery.port';

const CLAIM_LEASE_SECONDS = 60;

interface AnalyticsEventClaimRow {
  id: string;
  event_id: string;
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string | null;
  occurred_at: Date;
  correlation_id: string | null;
  payload: Record<string, unknown>;
}

/**
 * `analytics_events` (PostgreSQL, kaynak doğruluk) → BigQuery ham event tablosu.
 *
 * İkinci bir ingestion mimarisi değildir: girdi tamamen Faz 9'un
 * `AnalyticsExportConsumer`'ının doldurduğu tablodur. Bu servis yalnızca
 * export eder ve `exported_at`'i işaretler.
 *
 * Analitik hata **hiçbir zaman** transactional durumu bozmaz: bu servis
 * `analytics_events` dışındaki hiçbir tabloya yazmaz; BigQuery'ye ulaşılamazsa
 * satırlar `exported_at = NULL` kalır ve bir sonraki turda tekrar denenir.
 */
@Injectable()
export class BigQueryExportService {
  private readonly batchSize: number;
  private readonly rawTable: string;

  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(BIGQUERY_PORT) private readonly bigQuery: BigQueryPort,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    config: AppConfigService,
  ) {
    this.batchSize = config.env.ANALYTICS_EXPORT_BATCH_SIZE;
    this.rawTable = config.env.BIGQUERY_RAW_TABLE;
  }

  /** Tek bir export turu. Testler bunu doğrudan çağırabilir. Dönen: export edilen satır sayısı. */
  async exportBatch(): Promise<number> {
    const claimed = await this.claimBatch();
    if (claimed.length === 0) {
      return 0;
    }

    const rows: AnalyticsEventRow[] = claimed.map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      occurredAt: row.occurred_at,
      correlationId: row.correlation_id,
      payload: row.payload,
    }));

    let result;
    try {
      result = await this.bigQuery.insertRows(this.rawTable, rows);
    } catch (error) {
      // Kira süresi dolunca satırlar kendiliğinden yeniden sahiplenilebilir olur;
      // burada başka bir şey yapmaya gerek yok (claim zaten atomikti).
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error), batchSize: rows.length },
        'BigQuery export turu başarısız — satırlar kira süresi dolunca yeniden denenecek',
      );
      return 0;
    }

    const rejected = new Set(result.rejectedEventIds);
    const exportedIds = claimed.filter((row) => !rejected.has(row.event_id)).map((row) => row.id);

    if (exportedIds.length > 0) {
      await this.pool.query(
        `UPDATE analytics_events SET exported_at = now(), export_claimed_until = NULL
           WHERE id = ANY($1::bigint[])`,
        [exportedIds],
      );
    }

    if (rejected.size > 0) {
      // Kalıcı olarak reddedilen satırlar (şema uyuşmazlığı) sonsuza dek kira
      // dolup yeniden denenir ve tekrar reddedilir — sessizce kaybolmazlar,
      // DLQ'suz ama görünür (log + Faz 12'de metrik/alarm bağlanabilir).
      this.logger.warn(
        { rejectedEventIds: [...rejected] },
        'BigQuery bazı satırları reddetti — exported_at işaretlenmedi',
      );
    }

    this.logger.info(
      { exported: exportedIds.length, rejected: rejected.size, claimed: claimed.length },
      'BigQuery export turu tamamlandı',
    );

    return exportedIds.length;
  }

  /** Operasyonel görünürlük (Faz 10 `ops/health` deseniyle aynı fikir). */
  async status(): Promise<{
    unexportedCount: number;
    oldestUnexportedAgeMs: number | null;
    lastExportedAt: Date | null;
  }> {
    const result = await this.pool.query<{
      unexported_count: string;
      oldest_unexported_age_ms: string | null;
      last_exported_at: Date | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE exported_at IS NULL)::text AS unexported_count,
         EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE exported_at IS NULL))) * 1000
           AS oldest_unexported_age_ms,
         max(exported_at) AS last_exported_at
       FROM analytics_events`,
    );
    const row = result.rows[0];
    return {
      unexportedCount: parseInt(row?.unexported_count ?? '0', 10),
      oldestUnexportedAgeMs:
        row?.oldest_unexported_age_ms !== null && row?.oldest_unexported_age_ms !== undefined
          ? Math.round(Number(row.oldest_unexported_age_ms))
          : null,
      lastExportedAt: row?.last_exported_at ?? null,
    };
  }

  private async claimBatch(): Promise<AnalyticsEventClaimRow[]> {
    const result = await this.pool.query<AnalyticsEventClaimRow>(
      `UPDATE analytics_events
          SET export_claimed_until = now() + ($2 || ' seconds')::interval
        WHERE id IN (
          SELECT id
            FROM analytics_events
           WHERE exported_at IS NULL
             AND (export_claimed_until IS NULL OR export_claimed_until <= now())
           ORDER BY created_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, event_id, event_type, event_version, aggregate_type, aggregate_id,
                  occurred_at, correlation_id, payload`,
      [this.batchSize, String(CLAIM_LEASE_SECONDS)],
    );
    return result.rows;
  }
}
