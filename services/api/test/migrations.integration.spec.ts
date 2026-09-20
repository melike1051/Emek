import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool } from 'pg';

/**
 * Migration'ların gerçek PostgreSQL+PostGIS üzerinde ileri ve geri çalıştığını doğrular.
 * Altyapı ayakta değilse test atlanmaz, **başarısız olur** — sessiz atlama
 * migration ve constraint regresyonlarını saklar.
 *
 * Yalnızca `_test` ile biten veritabanında çalışır (bkz. test/setup-integration.ts).
 * Çalıştırmak için: npm run infra:up (repo kökünden), sonra npm run test:integration
 */

const API_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(API_ROOT, '../..');
const MIGRATE_CLI = resolve(REPO_ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');

function runMigration(direction: 'up' | 'down'): void {
  execFileSync(process.execPath, [MIGRATE_CLI, direction, ...(direction === 'down' ? ['0'] : [])], {
    cwd: API_ROOT,
    env: process.env,
    stdio: 'pipe',
  });
}

async function scalar<T>(pool: Pool, sql: string, params: unknown[] = []): Promise<T> {
  const result = await pool.query<Record<string, T>>(sql, params);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`sorgu satır döndürmedi: ${sql}`);
  }
  return Object.values(row)[0] as T;
}

describe('initial migration', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

    // Bağlantıyı en başta ve açıkça doğrula: hata mesajı "altyapı kapalı" olmalı,
    // sonraki testlerde anlamsız bir SQL hatası olmamalı.
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error("PostgreSQL erişilemiyor. Repo kökünden 'npm run infra:up' çalıştırın.", {
        cause: error,
      });
    }

    runMigration('down');
    runMigration('up');
  });

  // Her test kendi verisiyle başlar: sıralamaya bağımlı, sızdıran testler olmaz.
  afterEach(async () => {
    await pool.query('TRUNCATE TABLE user_roles, users CASCADE');
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('gerekli extension.ları kurar', async () => {
    const extensions = await pool.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname IN ('postgis','pgcrypto') ORDER BY extname`,
    );

    expect(extensions.rows.map((row) => row.extname)).toEqual(['pgcrypto', 'postgis']);
  });

  it('PostGIS fonksiyonları kullanılabilir', async () => {
    const version = await scalar<string>(pool, 'SELECT postgis_version()');

    expect(version).toMatch(/\d+\.\d+/);
  });

  it('Faz 1 enum tiplerini oluşturur', async () => {
    const types = await pool.query<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE typname IN ('user_status','app_role') ORDER BY typname`,
    );

    expect(types.rows.map((row) => row.typname)).toEqual(['app_role', 'user_status']);
  });

  // Faz 1'de bilinçli olarak yoktu; Faz 3'te onları kullanan ilk tabloyla birlikte geldi.
  it('doğrulama enum.ları kimlik tablolarıyla birlikte gelir (Faz 3)', async () => {
    const count = await scalar<string>(
      pool,
      `SELECT count(*)::text FROM pg_type
       WHERE typname IN ('verification_status','verification_level')`,
    );

    expect(count).toBe('2');
  });

  // Sıra ADR-0004 ile aynı olmalı: seviye karşılaştırmaları buna dayanır.
  it('verification_level değerleri ADR-0004 sırasındadır', async () => {
    const labels = await pool.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'verification_level'
       ORDER BY e.enumsortorder`,
    );

    expect(labels.rows.map((row) => row.enumlabel)).toEqual([
      'UNVERIFIED',
      'PHONE_VERIFIED',
      'IDENTITY_VERIFIED',
      'PROVIDER_VERIFIED',
      'FULLY_VERIFIED',
    ]);
  });

  it('app_role değerleri RBAC rolleriyle aynıdır', async () => {
    const labels = await pool.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'app_role'
       ORDER BY e.enumsortorder`,
    );

    expect(labels.rows.map((row) => row.enumlabel)).toEqual([
      'CUSTOMER',
      'PROVIDER',
      'ADMIN',
      'SUPPORT',
    ]);
  });

  it('users ve user_roles tablolarını oluşturur', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('users','user_roles')
       ORDER BY table_name`,
    );

    expect(tables.rows.map((row) => row.table_name)).toEqual(['user_roles', 'users']);
  });

  it('iletişim bilgisi olmayan kullanıcıyı reddeder', async () => {
    await expect(pool.query(`INSERT INTO users (status) VALUES ('PENDING')`)).rejects.toThrow(
      /users_contact_present/,
    );
  });

  it('e-posta tekilliğini büyük/küçük harf duyarsız uygular', async () => {
    await pool.query(`INSERT INTO users (email) VALUES ('Ayse@example.com')`);

    await expect(
      pool.query(`INSERT INTO users (email) VALUES ('ayse@example.com')`),
    ).rejects.toThrow(/uq_users_email/);
  });

  it('telefon tekilliğini uygular ama NULL telefonları serbest bırakır', async () => {
    await pool.query(`INSERT INTO users (phone) VALUES ('+905551112233')`);

    await expect(pool.query(`INSERT INTO users (phone) VALUES ('+905551112233')`)).rejects.toThrow(
      /uq_users_phone/,
    );

    // Aynı anda birden fazla telefonsuz (yalnızca e-postalı) kullanıcı olabilmeli.
    await pool.query(`INSERT INTO users (email) VALUES ('a@example.com')`);
    await pool.query(`INSERT INTO users (email) VALUES ('b@example.com')`);
  });

  // ADR-0004: normalize edilmemiş telefon = aynı kişi için birden fazla hesap yolu.
  it.each(['0555 111 22 33', '+90 555 111 22 33', '905551112233', '+90555abc', '+0555111223'])(
    'E.164 dışındaki telefon biçimini reddeder: %s',
    async (phone) => {
      await expect(pool.query(`INSERT INTO users (phone) VALUES ($1)`, [phone])).rejects.toThrow(
        /users_phone_e164/,
      );
    },
  );

  it('E.164 biçimli telefonu kabul eder', async () => {
    await pool.query(`INSERT INTO users (phone) VALUES ('+905551112244')`);

    const count = await scalar<string>(pool, `SELECT count(*)::text FROM users`);
    expect(count).toBe('1');
  });

  it('silinmiş kullanıcı iletişim bilgisini serbest bırakmaz', async () => {
    // Tekillik DELETED kayıtları da kapsar: aksi halde geçmişten kopuk ikinci bir
    // kimlik aynı e-posta ile açılabilir (ADR-0004).
    await pool.query(`INSERT INTO users (email, status) VALUES ('gone@example.com', 'DELETED')`);

    await expect(
      pool.query(`INSERT INTO users (email) VALUES ('gone@example.com')`),
    ).rejects.toThrow(/uq_users_email/);
  });

  it('aynı kullanıcıya birden fazla rol verilebilir, tekrar eden rol reddedilir', async () => {
    const userId = await scalar<string>(
      pool,
      `INSERT INTO users (email) VALUES ('multi-role@example.com') RETURNING id`,
    );

    await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'CUSTOMER')`, [userId]);
    await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'PROVIDER')`, [userId]);

    await expect(
      pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'CUSTOMER')`, [userId]),
    ).rejects.toThrow(/user_roles_pkey/);
  });

  it('bilinmeyen rol değerini reddeder', async () => {
    const userId = await scalar<string>(
      pool,
      `INSERT INTO users (email) VALUES ('bad-role@example.com') RETURNING id`,
    );

    await expect(
      pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'SUPERADMIN')`, [userId]),
    ).rejects.toThrow(/app_role/);
  });

  it('kullanıcı silindiğinde rolleri de silinir', async () => {
    const userId = await scalar<string>(
      pool,
      `INSERT INTO users (email) VALUES ('cascade@example.com') RETURNING id`,
    );
    await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'CUSTOMER')`, [userId]);

    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const remaining = await scalar<string>(
      pool,
      `SELECT count(*)::text FROM user_roles WHERE user_id = $1`,
      [userId],
    );
    expect(remaining).toBe('0');
  });

  it('updated_at trigger ile otomatik güncellenir', async () => {
    const userId = await scalar<string>(
      pool,
      `INSERT INTO users (email) VALUES ('touch@example.com') RETURNING id`,
    );
    const before = await scalar<Date>(pool, `SELECT updated_at FROM users WHERE id = $1`, [userId]);

    await pool.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [userId]);
    const after = await scalar<Date>(pool, `SELECT updated_at FROM users WHERE id = $1`, [userId]);

    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('paylaşılan trigger fonksiyonu sabit search_path ile tanımlıdır', async () => {
    const config = await scalar<string[] | null>(
      pool,
      `SELECT proconfig FROM pg_proc WHERE proname = 'set_updated_at'`,
    );

    expect(config).toContain('search_path=pg_catalog, pg_temp');
  });

  it('geri alınabilir: down migration şemayı temizler, sonra yeniden kurulabilir', async () => {
    runMigration('down');

    const tables = await scalar<string>(
      pool,
      `SELECT count(*)::text FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('users','user_roles')`,
    );
    const types = await scalar<string>(
      pool,
      `SELECT count(*)::text FROM pg_type WHERE typname IN ('user_status','app_role')`,
    );
    const functions = await scalar<string>(
      pool,
      `SELECT count(*)::text FROM pg_proc WHERE proname = 'set_updated_at'`,
    );

    expect(tables).toBe('0');
    expect(types).toBe('0');
    expect(functions).toBe('0');

    // Sonraki testler için şemayı geri kur (ve up yönünün tekrar çalıştığını doğrula).
    runMigration('up');

    const restored = await scalar<string>(
      pool,
      `SELECT count(*)::text FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    expect(restored).toBe('1');
  });
});
