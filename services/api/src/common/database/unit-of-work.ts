import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import { POSTGRES_POOL } from './database.tokens';

/**
 * Süren transaction'ın bağlantısı.
 *
 * Yalnızca **yanlış kullanımı tespit etmek** için tutulur; bağlantı buradan örtük
 * olarak alınmaz. Örtük alma, transaction dışında olması gereken bir okumayı sessizce
 * transaction'ın içine çekerdi; hata yüzeye çıkmalı, gizlenmemeli.
 */
const activeTransaction = new AsyncLocalStorage<PoolClient>();

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
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let rollbackError: unknown;

    try {
      return await activeTransaction.run(client, async () => {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      });
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

  /**
   * Verilen transaction bağlantısında, yoksa havuzda çalıştırır.
   *
   * Bir transaction sürerken `query()` çağırmak **aynı havuzdan ikinci bir bağlantı**
   * ister. Uçuştaki istek sayısı havuz boyutuna ulaştığında her bağlantı, ikinci bir
   * bağlantı bekleyen bir transaction tarafından tutulur ve hiçbiri ilerleyemez:
   * havuz kendi kendine kilitlenir (Faz 14 / EXP-007 bulgusu). Transaction içinden
   * çağrılan okumalar bu yüzden bağlantıyı taşır; ayrıca okuma transaction'ın kendi
   * anlık görüntüsünü görür, ki doğru olan da budur.
   */
  async queryOn<T extends QueryResultRow>(
    client: PoolClient | undefined,
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    if (client === undefined) {
      return this.query<T>(sql, params);
    }
    const result = await client.query<T>(sql, params);
    return result.rows;
  }

  /**
   * Transaction gerektirmeyen okumalar için.
   *
   * Süren bir transaction varken çağrılırsa bu, **istek başına ikinci bir bağlantı**
   * demektir ve uçuştaki istek sayısı havuz boyutuna ulaştığında havuz kendi kendine
   * kilitlenir (Faz 14 / EXP-007). Testte yüksek sesle düşer; üretimde kapasite
   * sessizce kaybolmasın diye hata olarak loglanır. Çözüm: bağlantıyı taşı
   * (`queryOn(client, ...)`).
   *
   * **Tespitin bilinen sınırı** (Faz 14 code review): `AsyncLocalStorage` bağlamı,
   * `withTransaction` içinde başlatılıp **beklenmeyen** (fire-and-forget) bir işe de
   * taşınır. Böyle bir iş `client.release()`'ten sonra çözülürse burada yanlış
   * pozitif üretir — transaction çoktan bitmiştir ama store hâlâ görünür. Bugün
   * böyle bir çağrı yolu yok (tüm `query()` çağrıları transaction dışı okuma
   * yollarında); eklenirse belirti, gerçek bir kilitlenme değil, açıklaması bu
   * yorumda olan bir test hatası olacaktır.
   */
  async query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> {
    const inTransaction = activeTransaction.getStore();
    if (inTransaction !== undefined) {
      const message =
        'Süren transaction içinde havuzdan ikinci bağlantı istendi (havuz kilitlenmesi riski); queryOn(client, ...) kullanın';
      if (process.env.NODE_ENV === 'test') {
        throw new Error(message);
      }
      this.logger.error({ metric: 'db.pool.nested_connection', sql: sql.slice(0, 120) }, message);
    }
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }
}
