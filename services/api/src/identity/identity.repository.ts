import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { UnitOfWork } from '../common/database/unit-of-work';
import type {
  AssuranceLevel,
  IdentityRecord,
  VerificationAttempt,
  VerificationLevel,
  VerificationPurpose,
  VerificationStatus,
} from './identity.types';

interface IdentityRow {
  user_id: string;
  verification_provider: string;
  provider_subject_id: string;
  verification_level: VerificationLevel;
  verification_status: VerificationStatus;
  assurance_level: AssuranceLevel;
  verified_at: Date | null;
  has_identity_hash: boolean;
}

interface AttemptRow {
  id: string;
  user_id: string;
  provider: string;
  external_session_id: string;
  method: string;
  purpose: VerificationPurpose;
  status: VerificationStatus;
  result_code: string | null;
  assurance_level: AssuranceLevel | null;
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
}

type Executor = Pick<PoolClient, 'query'>;

/**
 * `identity_hash` bu katmanın dışına çıkmaz: sorgular yalnızca hash'in **varlığını**
 * döner. Hash'i uygulama içinde dolaştırmak, log/yanıt sızıntısı yüzeyini büyütür.
 */
const SELECT_IDENTITY = `
  SELECT user_id, verification_provider, provider_subject_id, verification_level,
         verification_status, assurance_level, verified_at,
         (identity_hash IS NOT NULL) AS has_identity_hash
    FROM identity_records
`;

function toRecord(row: IdentityRow): IdentityRecord {
  return {
    userId: row.user_id,
    verificationProvider: row.verification_provider,
    providerSubjectId: row.provider_subject_id,
    verificationLevel: row.verification_level,
    verificationStatus: row.verification_status,
    assuranceLevel: row.assurance_level,
    verifiedAt: row.verified_at,
    hasIdentityHash: row.has_identity_hash,
  };
}

function toAttempt(row: AttemptRow): VerificationAttempt {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    externalSessionId: row.external_session_id,
    method: row.method,
    purpose: row.purpose,
    status: row.status,
    resultCode: row.result_code,
    assuranceLevel: row.assurance_level,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  };
}

@Injectable()
export class IdentityRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async findByUserId(userId: string, executor?: Executor): Promise<IdentityRecord | null> {
    const rows = await this.run<IdentityRow>(
      `${SELECT_IDENTITY} WHERE user_id = $1`,
      [userId],
      executor,
    );
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Hash sahibini bulur — tekillik kontrolünün ve recovery'nin kalbi.
   * Hash değeri dışarı çıkmaz; yalnızca sahibinin kullanıcı kimliği döner.
   */
  async findUserIdByHash(identityHash: string, executor?: Executor): Promise<string | null> {
    const rows = await this.run<{ user_id: string }>(
      `SELECT user_id FROM identity_records WHERE identity_hash = $1`,
      [identityHash],
      executor,
    );
    return rows[0]?.user_id ?? null;
  }

  /**
   * Kabuk hesabın kendine ait verisi var mı?
   *
   * Kurtarma, oturum kimliğini kanonik hesaba taşıyıp kabuk hesabı kapatır. Kabuk hesap
   * bu arada profil oluşturmuşsa (veya ileride booking/ödeme yapmışsa) bu veriler
   * kapatılmış bir hesapta asılı kalır: ne kanonik hesaba taşınır ne silinir. Böyle bir
   * durumda otomatik kurtarma yapılmaz, operasyon incelemesi gerekir.
   */
  async hasOwnData(userId: string, executor?: Executor): Promise<boolean> {
    const rows = await this.run<{ has_data: boolean }>(
      `SELECT (
         EXISTS (SELECT 1 FROM customer_profiles WHERE user_id = $1)
         OR EXISTS (SELECT 1 FROM provider_profiles WHERE user_id = $1)
         OR EXISTS (SELECT 1 FROM identity_records WHERE user_id = $1)
       ) AS has_data`,
      [userId],
      executor,
    );
    return rows[0]?.has_data ?? false;
  }

  /**
   * Kurtarma talebi oluşturur.
   *
   * Aynı hedef için bekleyen bir talep varsa `null` döner: operatör tek bir kararla
   * karşılaşmalı ve paralel taleplerle zorlama yolu kapalı olmalı.
   */
  async createRecoveryRequest(
    client: PoolClient,
    input: {
      requesterUserId: string;
      targetUserId: string;
      verificationAttemptId: string;
      assuranceLevel: AssuranceLevel;
    },
  ): Promise<string | null> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO account_recovery_requests
         (requester_user_id, target_user_id, verification_attempt_id, assurance_level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        input.requesterUserId,
        input.targetUserId,
        input.verificationAttemptId,
        input.assuranceLevel,
      ],
    );

    return result.rows[0]?.id ?? null;
  }

  async findRecoveryRequest(
    id: string,
    executor?: Executor,
  ): Promise<{
    id: string;
    requesterUserId: string;
    targetUserId: string;
    status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
    assuranceLevel: AssuranceLevel;
  } | null> {
    const rows = await this.run<{
      id: string;
      requester_user_id: string;
      target_user_id: string;
      status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
      assurance_level: AssuranceLevel;
    }>(
      `SELECT id, requester_user_id, target_user_id, status, assurance_level
         FROM account_recovery_requests
        WHERE id = $1
        FOR UPDATE`,
      [id],
      executor,
    );

    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          requesterUserId: row.requester_user_id,
          targetUserId: row.target_user_id,
          status: row.status,
          assuranceLevel: row.assurance_level,
        };
  }

  /**
   * Kurtarma kuyruğu (admin).
   *
   * Varsayılan olarak yalnızca `PENDING_REVIEW` döner — operatörün göreceği kuyruk
   * budur. `status` verilirse geçmiş kararlar da (denetim amaçlı) sorgulanabilir.
   */
  async listRecoveryRequests(filter: {
    status?: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<
    Array<{
      id: string;
      requesterUserId: string;
      targetUserId: string;
      status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
      assuranceLevel: AssuranceLevel;
      createdAt: Date;
      decidedAt: Date | null;
      decidedBy: string | null;
      decisionReason: string | null;
    }>
  > {
    const rows = await this.uow.query<{
      id: string;
      requester_user_id: string;
      target_user_id: string;
      status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
      assurance_level: AssuranceLevel;
      created_at: Date;
      decided_at: Date | null;
      decided_by: string | null;
      decision_reason: string | null;
    }>(
      `SELECT id, requester_user_id, target_user_id, status, assurance_level,
              created_at, decided_at, decided_by, decision_reason
         FROM account_recovery_requests
        WHERE ($1::text IS NULL OR status::text = $1)
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [
        filter.status ?? null,
        filter.before?.createdAt ?? null,
        filter.before?.id ?? null,
        filter.limit,
      ],
    );

    return rows.map((row) => ({
      id: row.id,
      requesterUserId: row.requester_user_id,
      targetUserId: row.target_user_id,
      status: row.status,
      assuranceLevel: row.assurance_level,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      decisionReason: row.decision_reason,
    }));
  }

  async decideRecoveryRequest(
    client: PoolClient,
    input: {
      id: string;
      status: 'APPROVED' | 'REJECTED';
      decidedBy: string;
      reason?: string;
    },
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE account_recovery_requests
          SET status = $2, decided_at = now(), decided_by = $3, decision_reason = $4
        WHERE id = $1 AND status = 'PENDING_REVIEW'`,
      [input.id, input.status, input.decidedBy, input.reason ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createAttempt(
    client: PoolClient,
    input: {
      userId: string;
      provider: string;
      externalSessionId: string;
      method: string;
      purpose: VerificationPurpose;
      expiresAt: Date;
    },
  ): Promise<VerificationAttempt> {
    const result = await client.query<AttemptRow>(
      `INSERT INTO verification_attempts
         (user_id, provider, external_session_id, method, purpose, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, provider, external_session_id, method, purpose, status,
                 result_code, assurance_level, created_at, expires_at, completed_at`,
      [
        input.userId,
        input.provider,
        input.externalSessionId,
        input.method,
        input.purpose,
        input.expiresAt,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('doğrulama denemesi oluşturulamadı');
    }
    return toAttempt(row);
  }

  async findAttemptById(id: string, userId?: string): Promise<VerificationAttempt | null> {
    // userId verildiğinde sorgu sahiplikle kapsanır: guard atlanmış olsa bile
    // başka kullanıcının oturumu dönmez (ADR-0013 §3).
    const rows = await this.uow.query<AttemptRow>(
      `SELECT id, user_id, provider, external_session_id, method, purpose, status,
              result_code, assurance_level, created_at, expires_at, completed_at
         FROM verification_attempts
        WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)`,
      [id, userId ?? null],
    );
    const row = rows[0];
    return row === undefined ? null : toAttempt(row);
  }

  async findAttemptBySession(
    provider: string,
    externalSessionId: string,
    executor?: Executor,
  ): Promise<VerificationAttempt | null> {
    const rows = await this.run<AttemptRow>(
      `SELECT id, user_id, provider, external_session_id, method, purpose, status,
              result_code, assurance_level, created_at, expires_at, completed_at
         FROM verification_attempts
        WHERE provider = $1 AND external_session_id = $2
        FOR UPDATE`,
      [provider, externalSessionId],
      executor,
    );
    const row = rows[0];
    return row === undefined ? null : toAttempt(row);
  }

  async completeAttempt(
    client: PoolClient,
    id: string,
    outcome: { status: VerificationStatus; resultCode: string; assuranceLevel: AssuranceLevel },
  ): Promise<void> {
    await client.query(
      `UPDATE verification_attempts
          SET status = $2, result_code = $3, assurance_level = $4, completed_at = now()
        WHERE id = $1`,
      [id, outcome.status, outcome.resultCode, outcome.assuranceLevel],
    );
  }

  async countRecentAttempts(userId: string, withinSeconds: number): Promise<number> {
    const rows = await this.uow.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM verification_attempts
        WHERE user_id = $1 AND created_at > now() - ($2 || ' seconds')::interval`,
      [userId, String(withinSeconds)],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Doğrulanmış kimlik kaydını yazar.
   *
   * Tekillik `uq_identity_records_hash` (sağlayıcıdan bağımsız) ve
   * `(verification_provider, provider_subject_id)` ile **veritabanında** zorlanır;
   * uygulama kontrolü ilk, DB constraint son savunmadır (ADR-0004 §2).
   */
  async upsertVerified(
    client: PoolClient,
    input: {
      userId: string;
      provider: string;
      providerSubjectId: string;
      identityHash: string;
      hashKeyVersion: string;
      assuranceLevel: AssuranceLevel;
      verifiedAt: Date;
    },
  ): Promise<IdentityRecord> {
    const result = await client.query<IdentityRow>(
      `INSERT INTO identity_records
         (user_id, verification_provider, provider_subject_id, identity_hash,
          hash_key_version, verification_level, verification_status, assurance_level, verified_at)
       VALUES ($1, $2, $3, $4, $5, 'IDENTITY_VERIFIED', 'VERIFIED', $6, $7)
       ON CONFLICT (user_id) DO UPDATE
         SET verification_provider = EXCLUDED.verification_provider,
             provider_subject_id = EXCLUDED.provider_subject_id,
             identity_hash = EXCLUDED.identity_hash,
             hash_key_version = EXCLUDED.hash_key_version,
             verification_level = EXCLUDED.verification_level,
             verification_status = EXCLUDED.verification_status,
             assurance_level = EXCLUDED.assurance_level,
             verified_at = EXCLUDED.verified_at
       RETURNING user_id, verification_provider, provider_subject_id, verification_level,
                 verification_status, assurance_level, verified_at,
                 (identity_hash IS NOT NULL) AS has_identity_hash`,
      [
        input.userId,
        input.provider,
        input.providerSubjectId,
        input.identityHash,
        input.hashKeyVersion,
        input.assuranceLevel,
        input.verifiedAt,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('kimlik kaydı yazılamadı');
    }
    return toRecord(row);
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
