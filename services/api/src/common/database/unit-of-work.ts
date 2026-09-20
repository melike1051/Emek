import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { POSTGRES_POOL } from './database.tokens';

/**
 * Tek transaction sınırı.
 *
 * Domain değişikliği, audit kaydı ve outbox event'i **aynı** transaction'da yazılır
 * (ADR-0010 §2, ADR-0013 §9). Bu yüzden repository'ler bir `PoolClient` alır:
 * "hangi bağlantıda çalıştığını bilmeyen" bir repository, transaction bütünlüğünü
 * sessizce bozar.
 */
@Injectable()
export class UnitOfWork {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let rollbackError: unknown;

    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (failure) {
        // Rollback başarısızsa bağlantı iptal edilmiş bir transaction içinde kalır.
        // Havuza sağlam gibi geri verilirse sonraki istekler "current transaction is
        // aborted" hatası alır; bu yüzden bağlantı yok edilir (release(error)).
        rollbackError = failure;
      }
      throw error;
    } finally {
      client.release(rollbackError === undefined ? undefined : (rollbackError as Error));
    }
  }

  /** Transaction gerektirmeyen okumalar için. */
  async query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }
}
