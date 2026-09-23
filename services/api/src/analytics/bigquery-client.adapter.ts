import { Injectable } from '@nestjs/common';
import { BigQuery } from '@google-cloud/bigquery';
import type { AnalyticsEventRow, BigQueryInsertResult, BigQueryPort } from './bigquery.port';
import { BigQueryPortError } from './bigquery.port';

/**
 * Üretim BigQuery adapter'ı (ADR-0021).
 *
 * Streaming insert kullanır (`table.insert`), her satır `insertId = eventId`
 * taşır: BigQuery bunu en-az-bir-kez teslimde **en iyi çaba** düzeyinde
 * tekilleştirir (kısa pencerede garantili, uzun vadede garantisiz —
 * belgelenen BigQuery davranışı). Kesin idempotency kaynağı çağıranın
 * (`BigQueryExportService`) PostgreSQL `exported_at` işaretidir; bu adapter
 * yalnızca "iyi çaba" ikinci bir savunma hattı ekler.
 */
@Injectable()
export class BigQueryClientAdapter implements BigQueryPort {
  readonly name = 'bigquery';

  constructor(
    private readonly client: BigQuery,
    private readonly datasetId: string,
  ) {}

  async insertRows(table: string, rows: AnalyticsEventRow[]): Promise<BigQueryInsertResult> {
    if (rows.length === 0) {
      return { rejectedEventIds: [] };
    }

    const payload = rows.map((row) => ({
      insertId: row.eventId,
      json: {
        event_id: row.eventId,
        event_type: row.eventType,
        event_version: row.eventVersion,
        aggregate_type: row.aggregateType,
        aggregate_id: row.aggregateId,
        occurred_at: row.occurredAt.toISOString(),
        correlation_id: row.correlationId,
        payload: JSON.stringify(row.payload),
        ingested_at: new Date().toISOString(),
      },
    }));

    try {
      await this.client
        .dataset(this.datasetId)
        .table(table)
        .insert(payload, { raw: true, skipInvalidRows: false, ignoreUnknownValues: false });
      return { rejectedEventIds: [] };
    } catch (error) {
      // PartialFailureError: bazı satırlar şema uyuşmazlığıyla reddedildi — bunlar
      // yeniden denenerek düzelmez (kalıcı), bu yüzden `exported_at` yine de
      // işaretlenmemesi için çağırana bildirilir; geri kalanı export edilmiş sayılır.
      const insertErrors = extractInsertErrors(error);
      if (insertErrors !== null) {
        return { rejectedEventIds: insertErrors };
      }
      const reason = error instanceof Error ? error.message : 'bilinmeyen BigQuery hatası';
      throw new BigQueryPortError(reason);
    }
  }
}

interface PartialFailureRow {
  insertId?: string;
  errors?: unknown[];
}

function extractInsertErrors(error: unknown): string[] | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('name' in error) ||
    (error as { name?: unknown }).name !== 'PartialFailureError'
  ) {
    return null;
  }
  const withErrors = error as { errors?: PartialFailureRow[] };
  if (!Array.isArray(withErrors.errors)) {
    return [];
  }
  return withErrors.errors
    .map((row) => row.insertId)
    .filter((id): id is string => typeof id === 'string');
}
