import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { Inject } from '@nestjs/common';
import { POSTGRES_POOL } from '../database/database.tokens';

export const IDEMPOTENCY_TTL_HOURS = 24;
/**
 * Bir rezervasyonun "işleniyor" sayılacağı azami süre.
 *
 * Süreç istek ortasında çökerse kayıt IN_PROGRESS kalır. Bu süre olmadan istemci,
 * TTL boyunca (24 saat) aynı anahtarla hiçbir zaman ilerleyemez; her denemesi
 * `IDEMPOTENCY_IN_PROGRESS` alırdı.
 */
export const IN_PROGRESS_LEASE_SECONDS = 60;

export interface StoredResponse {
  status: number;
  body: unknown;
}

export type IdempotencyLookup =
  | { outcome: 'FIRST_REQUEST' }
  | { outcome: 'COMPLETED'; response: StoredResponse }
  | { outcome: 'IN_PROGRESS' }
  | { outcome: 'FINGERPRINT_MISMATCH' };

/**
 * Kalıcı idempotency kaydı (ADR-0003).
 *
 * Kayıt PostgreSQL'de tutulur: Redis flush'ı veya yeniden başlatma, aynı komutun
 * ikinci kez yan etki üretmesine yol açamaz. Aynı key farklı istek gövdesiyle
 * geldiğinde istek reddedilir — sessizce ilk yanıtı döndürmek, istemcinin farklı bir
 * işlem yaptığını sanmasına neden olur.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  fingerprint(payload: unknown): string {
    // Alan sırasına duyarsız, deterministik gösterim.
    return createHash('sha256').update(canonicalize(payload)).digest('hex');
  }

  /**
   * Anahtarı rezerve eder. `FIRST_REQUEST` dönerse çağıran işlemi yürütür ve
   * sonunda `complete()` çağırır.
   */
  async begin(scope: string, key: string, fingerprint: string): Promise<IdempotencyLookup> {
    const inserted = await this.pool.query<{ key: string }>(
      `INSERT INTO idempotency_keys (scope, key, request_fingerprint, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval)
       ON CONFLICT (scope, key) DO NOTHING
       RETURNING key`,
      [scope, key, fingerprint, String(IDEMPOTENCY_TTL_HOURS)],
    );

    if (inserted.rows.length > 0) {
      return { outcome: 'FIRST_REQUEST' };
    }

    const existing = await this.pool.query<{
      request_fingerprint: string;
      status: 'IN_PROGRESS' | 'COMPLETED';
      response_status: number | null;
      response_body: unknown;
    }>(
      `SELECT request_fingerprint, status, response_status, response_body
         FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [scope, key],
    );

    const row = existing.rows[0];
    if (row === undefined) {
      // Kayıt araya giren bir temizlik işiyle silindi; yeni istek gibi davran.
      return { outcome: 'FIRST_REQUEST' };
    }

    if (row.request_fingerprint !== fingerprint) {
      return { outcome: 'FINGERPRINT_MISMATCH' };
    }

    if (row.status === 'COMPLETED' && row.response_status !== null) {
      return {
        outcome: 'COMPLETED',
        response: { status: row.response_status, body: row.response_body },
      };
    }

    // Çökme sonrası asılı kalmış rezervasyonu devral: yalnızca hâlâ IN_PROGRESS ise ve
    // kiralama süresi dolmuşsa. Koşullu UPDATE, iki istemcinin aynı anda devralmasını
    // engeller — biri satırı günceller, diğeri 0 satır görür ve IN_PROGRESS alır.
    const takeover = await this.pool.query(
      `UPDATE idempotency_keys
          SET created_at = now()
        WHERE scope = $1 AND key = $2
          AND status = 'IN_PROGRESS'
          AND created_at < now() - ($3 || ' seconds')::interval`,
      [scope, key, String(IN_PROGRESS_LEASE_SECONDS)],
    );

    if ((takeover.rowCount ?? 0) > 0) {
      return { outcome: 'FIRST_REQUEST' };
    }

    return { outcome: 'IN_PROGRESS' };
  }

  async complete(
    scope: string,
    key: string,
    response: StoredResponse,
    client?: PoolClient,
  ): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      `UPDATE idempotency_keys
          SET status = 'COMPLETED', completed_at = now(), response_status = $3, response_body = $4
        WHERE scope = $1 AND key = $2`,
      [scope, key, response.status, JSON.stringify(response.body ?? null)],
    );
  }

  /** İşlem başarısız olduysa anahtar serbest bırakılır: istemci yeniden deneyebilmeli. */
  async release(scope: string, key: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2 AND status = 'IN_PROGRESS'`,
      [scope, key],
    );
  }

  /** Süresi geçmiş kayıtları siler; operasyonel iş Faz 12'de zamanlanır. */
  async purgeExpired(): Promise<number> {
    const result = await this.pool.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
    return result.rowCount ?? 0;
  }
}

/** JSON'u alan sırasından bağımsız, deterministik bir metne çevirir. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([childKey, child]) => `${JSON.stringify(childKey)}:${canonicalize(child)}`);

  return `{${entries.join(',')}}`;
}
