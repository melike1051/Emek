import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { POSTGRES_POOL } from '../common/database/database.tokens';
import { UnitOfWork } from '../common/database/unit-of-work';
import { AppConfigService } from '../common/config/app-config.service';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';

export type DiscrepancyType =
  'STUCK_PENDING_COMMAND' | 'AUTHORIZATION_EXPIRED_UNHANDLED' | 'RELEASE_PENDING_STALLED';

export interface ReconciliationRunSummary {
  runId: string;
  checkedCount: number;
  discrepancyCount: number;
  newDiscrepancyCount: number;
}

export interface ReconciliationDiscrepancyRecord {
  id: string;
  runId: string;
  paymentId: string;
  discrepancyType: DiscrepancyType;
  details: Record<string, unknown>;
  detectedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

interface Candidate {
  paymentId: string;
  discrepancyType: DiscrepancyType;
  details: Record<string, unknown>;
}

/**
 * Ödeme mutabakat taraması (Faz 11, ADR-0021).
 *
 * **Kapsam sınırı (bilinçli, R-79):** dış PSP ekstresiyle karşılaştırma yapmaz —
 * `PaymentProvider` portunda işlem listesi çeken bir yetenek yok. Bu yüzden tarama,
 * Emek'in kendi komut defteri (`payment_commands`) ile gerçekleşen durumun
 * (`payments`) kendi içinde sürüklenip sürüklenmediğini tespit eder: yanıtsız kalmış
 * komutlar, işlenmemiş yetki süresi dolumları, takılı release'ler.
 *
 * **Para hareketi tetiklemez.** Yalnızca `payment_reconciliation_discrepancies`'e
 * yazar; operatör (Faz 10 ops deseniyle) inceleyip kapatır.
 */
@Injectable()
export class ReconciliationService {
  private readonly stuckCommandMinutes: number;
  private readonly authExpiryGraceMinutes: number;
  private readonly releasePendingGraceMinutes: number;

  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    config: AppConfigService,
  ) {
    this.stuckCommandMinutes = config.env.RECONCILIATION_STUCK_COMMAND_MINUTES;
    this.authExpiryGraceMinutes = config.env.RECONCILIATION_AUTH_EXPIRY_GRACE_MINUTES;
    this.releasePendingGraceMinutes = config.env.RECONCILIATION_RELEASE_PENDING_GRACE_MINUTES;
  }

  async run(
    triggeredBy: 'SCHEDULED' | 'MANUAL',
    actorUserId?: string,
  ): Promise<ReconciliationRunSummary> {
    const runId = await this.startRun(triggeredBy);

    try {
      const [stuckCommands, expiredAuth, stalledRelease] = await Promise.all([
        this.findStuckPendingCommands(),
        this.findExpiredAuthorizationsUnhandled(),
        this.findReleasePendingStalled(),
      ]);
      const [stuckPendingTotal, authorizedTotal, releasePendingTotal] = await Promise.all([
        this.countPendingCommands(),
        this.countAuthorizedOrHeld(),
        this.countReleasePending(),
      ]);

      const candidates = [...stuckCommands, ...expiredAuth, ...stalledRelease];
      let newDiscrepancyCount = 0;
      for (const candidate of candidates) {
        const inserted = await this.recordDiscrepancy(runId, candidate);
        if (inserted) {
          newDiscrepancyCount += 1;
        }
      }

      const checkedCount = stuckPendingTotal + authorizedTotal + releasePendingTotal;
      await this.pool.query(
        `UPDATE payment_reconciliation_runs
            SET status = 'COMPLETED', finished_at = now(), checked_count = $2, discrepancy_count = $3
          WHERE id = $1`,
        [runId, checkedCount, candidates.length],
      );

      if (actorUserId !== undefined) {
        await this.uow.withTransaction(async (client) => {
          await this.audit.record(client, {
            action: AuditAction.RECONCILIATION_RUN_COMPLETED,
            entityType: 'payment_reconciliation_run',
            actorUserId,
            newValue: {
              runId,
              checkedCount,
              discrepancyCount: candidates.length,
              newDiscrepancyCount,
            },
          });
        });
      }

      return { runId, checkedCount, discrepancyCount: candidates.length, newDiscrepancyCount };
    } catch (error) {
      await this.pool.query(
        `UPDATE payment_reconciliation_runs SET status = 'FAILED', finished_at = now() WHERE id = $1`,
        [runId],
      );
      throw error;
    }
  }

  private async startRun(triggeredBy: 'SCHEDULED' | 'MANUAL'): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO payment_reconciliation_runs (triggered_by) VALUES ($1) RETURNING id::text`,
      [triggeredBy],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error('mutabakat turu oluşturulamadı');
    }
    return id;
  }

  private async findStuckPendingCommands(): Promise<Candidate[]> {
    const result = await this.pool.query<{
      payment_id: string;
      id: string;
      operation: string;
      attempt: number;
      created_at: Date;
      age_minutes: string;
    }>(
      `SELECT payment_id, id::text, operation, attempt, created_at,
              EXTRACT(EPOCH FROM (now() - created_at)) / 60 AS age_minutes
         FROM payment_commands
        WHERE status = 'PENDING'
          AND created_at < now() - ($1 || ' minutes')::interval`,
      [String(this.stuckCommandMinutes)],
    );
    return result.rows.map((row) => ({
      paymentId: row.payment_id,
      discrepancyType: 'STUCK_PENDING_COMMAND',
      details: {
        commandId: row.id,
        operation: row.operation,
        attempt: row.attempt,
        createdAt: row.created_at.toISOString(),
        ageMinutes: Math.round(Number(row.age_minutes)),
      },
    }));
  }

  private async findExpiredAuthorizationsUnhandled(): Promise<Candidate[]> {
    const result = await this.pool.query<{
      id: string;
      status: string;
      authorization_expires_at: Date;
      overdue_minutes: string;
    }>(
      `SELECT id::text, status, authorization_expires_at,
              EXTRACT(EPOCH FROM (now() - authorization_expires_at)) / 60 AS overdue_minutes
         FROM payments
        WHERE status IN ('AUTHORIZED', 'HELD')
          AND authorization_expires_at < now() - ($1 || ' minutes')::interval`,
      [String(this.authExpiryGraceMinutes)],
    );
    return result.rows.map((row) => ({
      paymentId: row.id,
      discrepancyType: 'AUTHORIZATION_EXPIRED_UNHANDLED',
      details: {
        status: row.status,
        authorizationExpiresAt: row.authorization_expires_at.toISOString(),
        overdueMinutes: Math.round(Number(row.overdue_minutes)),
      },
    }));
  }

  private async findReleasePendingStalled(): Promise<Candidate[]> {
    const result = await this.pool.query<{
      id: string;
      updated_at: Date;
      stalled_minutes: string;
    }>(
      `SELECT id::text, updated_at,
              EXTRACT(EPOCH FROM (now() - updated_at)) / 60 AS stalled_minutes
         FROM payments
        WHERE status = 'RELEASE_PENDING'
          AND updated_at < now() - ($1 || ' minutes')::interval`,
      [String(this.releasePendingGraceMinutes)],
    );
    return result.rows.map((row) => ({
      paymentId: row.id,
      discrepancyType: 'RELEASE_PENDING_STALLED',
      details: {
        updatedAt: row.updated_at.toISOString(),
        stalledMinutes: Math.round(Number(row.stalled_minutes)),
      },
    }));
  }

  private async countPendingCommands(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payment_commands WHERE status = 'PENDING'`,
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  private async countAuthorizedOrHeld(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payments WHERE status IN ('AUTHORIZED', 'HELD')`,
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  private async countReleasePending(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payments WHERE status = 'RELEASE_PENDING'`,
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /** Zaten açık (çözülmemiş) aynı ödeme+tip bulgusu varsa yeniden yazmaz. */
  private async recordDiscrepancy(runId: string, candidate: Candidate): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO payment_reconciliation_discrepancies
         (run_id, payment_id, discrepancy_type, details)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (payment_id, discrepancy_type) WHERE resolved_at IS NULL
       DO NOTHING`,
      [runId, candidate.paymentId, candidate.discrepancyType, JSON.stringify(candidate.details)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async list(filter: {
    resolved?: boolean;
    discrepancyType?: DiscrepancyType;
    limit: number;
    before?: { detectedAt: Date; id: string };
  }): Promise<ReconciliationDiscrepancyRecord[]> {
    const result = await this.pool.query<{
      id: string;
      run_id: string;
      payment_id: string;
      discrepancy_type: DiscrepancyType;
      details: Record<string, unknown>;
      detected_at: Date;
      resolved_at: Date | null;
      resolved_by: string | null;
    }>(
      `SELECT id::text, run_id::text, payment_id, discrepancy_type, details,
              detected_at, resolved_at, resolved_by
         FROM payment_reconciliation_discrepancies
        WHERE ($1::boolean IS NULL OR (resolved_at IS NOT NULL) = $1)
          AND ($2::text IS NULL OR discrepancy_type = $2)
          AND ($3::timestamptz IS NULL OR (detected_at, id) < ($3, $4::bigint))
        ORDER BY detected_at DESC, id DESC
        LIMIT $5`,
      [
        filter.resolved ?? null,
        filter.discrepancyType ?? null,
        filter.before?.detectedAt ?? null,
        filter.before?.id ?? null,
        filter.limit,
      ],
    );
    return result.rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      paymentId: row.payment_id,
      discrepancyType: row.discrepancy_type,
      details: row.details,
      detectedAt: row.detected_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
    }));
  }

  /** Operasyonel çözüm: bulguyu kapatır. Audit aynı transaction'da yazılır. */
  async resolve(id: string, actorUserId: string): Promise<void> {
    await this.uow.withTransaction(async (client) => {
      const resolved = await this.resolveInTransaction(client, id, actorUserId);
      if (!resolved) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }
      await this.audit.record(client, {
        action: AuditAction.RECONCILIATION_DISCREPANCY_RESOLVED,
        entityType: 'payment_reconciliation_discrepancy',
        actorUserId,
        newValue: { discrepancyId: id },
      });
    });
  }

  private async resolveInTransaction(
    client: PoolClient,
    id: string,
    actorUserId: string,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE payment_reconciliation_discrepancies
          SET resolved_at = now(), resolved_by = $2
        WHERE id = $1::bigint AND resolved_at IS NULL`,
      [id, actorUserId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
