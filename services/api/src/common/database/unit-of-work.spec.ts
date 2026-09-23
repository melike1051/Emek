import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import { UnitOfWork } from './unit-of-work';

/**
 * Faz 14 — havuz kendi kendine kilitlenmesinin tespiti.
 *
 * EXP-007 yük ölçümünde bulunan sınıf: transaction sürerken havuzdan **ikinci** bir
 * bağlantı istemek. Uçuştaki istek sayısı havuz boyutuna ulaştığında hiçbir istek
 * ilerleyemez. Buradaki testler, tespitin gerçekten çalıştığını ve doğru kullanımın
 * (bağlantıyı taşımak) engellenmediğini sabitler.
 */
describe('UnitOfWork', () => {
  const makeClient = (): PoolClient =>
    ({
      query: jest.fn().mockResolvedValue({ rows: [{ value: 'client' }] }),
      release: jest.fn(),
    }) as unknown as PoolClient;

  const makePool = (client: PoolClient): Pool =>
    ({
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn().mockResolvedValue({ rows: [{ value: 'pool' }] }),
    }) as unknown as Pool;

  const logger = { error: jest.fn() } as unknown as Logger;

  it('transaction dışında query havuzu kullanır', async () => {
    const client = makeClient();
    const pool = makePool(client);
    const uow = new UnitOfWork(pool, logger);

    await expect(uow.query('SELECT 1')).resolves.toEqual([{ value: 'pool' }]);
  });

  it('transaction içinde havuz sorgusu testte yüksek sesle düşer', async () => {
    const client = makeClient();
    const pool = makePool(client);
    const uow = new UnitOfWork(pool, logger);

    // NODE_ENV=test: sessiz bir kapasite uçurumu yerine kırmızı bir test.
    await expect(
      uow.withTransaction(async () => {
        await uow.query('SELECT 1');
      }),
    ).rejects.toThrow(/havuz kilitlenmesi riski/);

    // Hata yüzeye çıktığı için transaction geri alınır ve bağlantı bırakılır.
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('üretimde aynı durum hata olarak loglanır ve sorgu yine çalışır', async () => {
    // Gönderilen dal, testte **hiç koşmayan** daldır: `NODE_ENV=test` her zaman
    // fırlatma tarafına sapar. Üretimde ne olduğunu sabitlemeden bırakmak,
    // yalnızca çalıştırmadığımız kodu göndermek olurdu (Faz 14 code review).
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const client = makeClient();
    const pool = makePool(client);
    const error = jest.fn();
    const uow = new UnitOfWork(pool, { error } as unknown as Logger);

    try {
      await uow.withTransaction(async () => {
        // Üretimde istek düşmez: kapasite sessizce kaybolmasın diye loglanır ama
        // iş devam eder. Bu bilinçli bir taviz — koruma yalnızca testte bağlayıcıdır.
        await expect(uow.query('SELECT 1')).resolves.toEqual([{ value: 'pool' }]);
      });
    } finally {
      process.env.NODE_ENV = previous;
    }

    // Metrik adı sözleşmenin parçasıdır: Cloud Logging log tabanlı metriği
    // (`*-pool-nested-connection`) tam olarak bu alana bağlanır. Ad değişirse
    // alarm sessizce sıfıra düşer, bu yüzden burada sabitlenir (R-92).
    expect(error).toHaveBeenCalledWith(
      { metric: 'db.pool.nested_connection', sql: 'SELECT 1' },
      expect.stringMatching(/havuz kilitlenmesi riski/),
    );
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('queryOn bağlantıyı taşır: transaction içinde ikinci bağlantı istenmez', async () => {
    const client = makeClient();
    const pool = makePool(client);
    const uow = new UnitOfWork(pool, logger);

    const rows = await uow.withTransaction((tx) => uow.queryOn(tx, 'SELECT 1'));

    expect(rows).toEqual([{ value: 'client' }]);
    // Havuzdan yalnızca transaction bağlantısı alındı; ek `pool.query` yok.
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('queryOn bağlantısız çağrılırsa havuzu kullanır', async () => {
    const client = makeClient();
    const pool = makePool(client);
    const uow = new UnitOfWork(pool, logger);

    await expect(uow.queryOn(undefined, 'SELECT 1')).resolves.toEqual([{ value: 'pool' }]);
  });

  it('transaction bittikten sonra bağlam sızmaz', async () => {
    const client = makeClient();
    const pool = makePool(client);
    const uow = new UnitOfWork(pool, logger);

    await uow.withTransaction(async () => undefined);

    // Bağlam sızsaydı bu çağrı hatalı biçimde düşerdi.
    await expect(uow.query('SELECT 1')).resolves.toEqual([{ value: 'pool' }]);
  });
});
