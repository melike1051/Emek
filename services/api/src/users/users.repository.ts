import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { UnitOfWork } from '../common/database/unit-of-work';
import type { AppRole, User, UserStatus } from './user.types';

interface UserRow {
  id: string;
  phone: string | null;
  email: string | null;
  status: UserStatus;
  created_at: Date;
  last_login_at: Date | null;
  roles: AppRole[] | null;
}

type Executor = Pick<PoolClient, 'query'>;

/**
 * Faz 2'de tek kimlik sağlayıcısı var. Sabit burada tutulur ki sorgular sessizce
 * sağlayıcıdan bağımsız hale gelmesin (bkz. findByProviderSubject).
 */
export const DEFAULT_AUTH_PROVIDER = 'firebase';

function toUser(row: UserRow): User {
  return {
    id: row.id,
    phone: row.phone,
    email: row.email,
    status: row.status,
    roles: row.roles ?? [],
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

const SELECT_USER = `
  SELECT u.id, u.phone, u.email, u.status, u.created_at, u.last_login_at,
         -- app_role[] özel bir enum dizisidir ve pg sürücüsü onu ayrıştırmaz (ham '{CUSTOMER}'
  -- metni döner). ::text ile metin dizisine çevrilir; sürücü text[]'i dizi olarak verir.
  array_remove(array_agg(r.role::text ORDER BY r.role), NULL) AS roles
    FROM users u
    LEFT JOIN user_roles r ON r.user_id = u.id
`;

@Injectable()
export class UsersRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async findById(id: string, executor?: Executor): Promise<User | null> {
    const rows = await this.run<UserRow>(
      `${SELECT_USER} WHERE u.id = $1 GROUP BY u.id`,
      [id],
      executor,
    );
    const row = rows[0];
    return row === undefined ? null : toUser(row);
  }

  /**
   * Kimlik sağlayıcısının subject'i ile kullanıcıyı bulur.
   *
   * `provider` **her zaman** filtreye dahildir: tablo anahtarı `(provider, subject)`
   * olduğu için yalnızca subject ile arama, ikinci bir sağlayıcı eklendiği gün
   * B sağlayıcısında aynı subject dizesini kontrol eden birinin A sağlayıcısındaki
   * kullanıcı olarak kimlik doğrulamasına yol açardı.
   *
   * `identity_records` Faz 3'te geldiğinde doğrulanmış kimlik tekilliği oraya taşınacak;
   * bu tablo oturum kimliği eşlemesi olarak kalacak.
   */
  async findByProviderSubject(
    subject: string,
    executor?: Executor,
    provider: string = DEFAULT_AUTH_PROVIDER,
  ): Promise<User | null> {
    const rows = await this.run<UserRow>(
      `${SELECT_USER}
         JOIN auth_subjects s ON s.user_id = u.id
        WHERE s.provider = $2 AND s.provider_subject = $1 AND s.status = 'ACTIVE'
        GROUP BY u.id`,
      [subject, provider],
      executor,
    );
    const row = rows[0];
    return row === undefined ? null : toUser(row);
  }

  async createWithSubject(
    client: PoolClient,
    input: { subject: string; email?: string; phone?: string },
  ): Promise<User> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, phone, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [input.email ?? null, input.phone ?? null],
    );
    const created = inserted.rows[0];
    if (created === undefined) {
      throw new Error('kullanıcı oluşturulamadı');
    }

    await client.query(`INSERT INTO auth_subjects (user_id, provider_subject) VALUES ($1, $2)`, [
      created.id,
      input.subject,
    ]);

    const user = await this.findById(created.id, client);
    if (user === null) {
      throw new Error('oluşturulan kullanıcı okunamadı');
    }
    return user;
  }

  async grantRole(client: PoolClient, userId: string, role: AppRole): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, role],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateContact(
    client: PoolClient,
    userId: string,
    changes: { email?: string | null; phone?: string | null },
  ): Promise<User> {
    // COALESCE ile "gönderilmeyen alan değişmez" davranışı: kısmi güncelleme
    // istemeden alanı NULL'a çekmemeli.
    await client.query(
      `UPDATE users
          SET email = CASE WHEN $2::boolean THEN $3 ELSE email END,
              phone = CASE WHEN $4::boolean THEN $5 ELSE phone END
        WHERE id = $1`,
      [
        userId,
        changes.email !== undefined,
        changes.email ?? null,
        changes.phone !== undefined,
        changes.phone ?? null,
      ],
    );

    const user = await this.findById(userId, client);
    if (user === null) {
      throw new Error('güncellenen kullanıcı okunamadı');
    }
    return user;
  }

  async findAuthSubject(
    userId: string,
    executor?: Executor,
  ): Promise<{ provider: string; providerSubject: string } | null> {
    const rows = await this.run<{ provider: string; provider_subject: string }>(
      `SELECT provider, provider_subject FROM auth_subjects
        WHERE user_id = $1 AND status = 'ACTIVE'`,
      [userId],
      executor,
    );
    const row = rows[0];
    return row === null || row === undefined
      ? null
      : { provider: row.provider, providerSubject: row.provider_subject };
  }

  /**
   * Oturum kimliğini başka bir kullanıcıya taşır (hesap kurtarma — ADR-0004 §7).
   *
   * Hedef kullanıcının aynı sağlayıcıdaki **eski** kimliği önce iptal edilir:
   * kurtarmanın tanımı gereği kullanıcı ona erişimini kaybetmiştir ve telefon
   * numaraları operatörlerce yeniden tahsis edildiği için aktif bırakmak, numarayı
   * sonradan alan birine hesabı açık bırakmak olurdu.
   *
   * Taşıma tek UPDATE ile yapılır: PK `(provider, provider_subject)` olduğu için satır
   * kimliği değişmez ve arada "hiçbir kullanıcıya bağlı olmayan subject" penceresi oluşmaz.
   */
  async moveAuthSubject(
    client: PoolClient,
    input: { provider: string; subject: string; fromUserId: string; toUserId: string },
  ): Promise<void> {
    await client.query(
      `UPDATE auth_subjects
          SET status = 'REVOKED', revoked_at = now()
        WHERE user_id = $1 AND provider = $2 AND status = 'ACTIVE'`,
      [input.toUserId, input.provider],
    );

    const result = await client.query(
      `UPDATE auth_subjects
          SET user_id = $4
        WHERE provider = $1 AND provider_subject = $2 AND user_id = $3 AND status = 'ACTIVE'`,
      [input.provider, input.subject, input.fromUserId, input.toUserId],
    );

    if ((result.rowCount ?? 0) === 0) {
      throw new Error('oturum kimliği taşınamadı: aktif kayıt bulunamadı');
    }
  }

  /**
   * Kurtarma sonrası kalan kabuk hesabı kapatır.
   *
   * Kayıt silinmez: `audit_logs` bu kullanıcıya atıfta bulunur ve tarihsel iz korunur.
   * İletişim bilgileri serbest bırakılır ki kullanıcı bunları kanonik hesabına
   * taşıyabilsin (tekillik index'i DELETED kayıtları da kapsıyor — schema.md).
   */
  async markDeleted(client: PoolClient, userId: string): Promise<void> {
    // `deleted_at` retention saatini başlatır (Faz 12): profil verisinin
    // anonimleştirilmesi bu andan itibaren sayılır. Zaten kapatılmış bir hesabın
    // saati **sıfırlanmaz** — aksi halde tekrarlanan bir kapatma çağrısı
    // anonimleştirmeyi süresiz erteleyebilirdi.
    await client.query(
      `UPDATE users
          SET status = 'DELETED', email = NULL, phone = NULL,
              deleted_at = COALESCE(deleted_at, now())
        WHERE id = $1`,
      [userId],
    );
  }

  async touchLastLogin(client: PoolClient, userId: string): Promise<void> {
    await client.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
  }

  private async run<T extends QueryResultRow>(
    sql: string,
    params: unknown[],
    executor?: Executor,
  ): Promise<T[]> {
    if (executor !== undefined) {
      const result = await executor.query<T>(sql, params);
      return result.rows;
    }
    return this.uow.query<T>(sql, params);
  }
}
