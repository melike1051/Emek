import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { POSTGRES_POOL } from '../common/database/database.tokens';
import { UnitOfWork } from '../common/database/unit-of-work';
import { DeadLetterService, type DeadLetterRecord } from '../common/events/dead-letter.service';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import {
  NotificationJobsRepository,
  type NotificationJobRecord,
  type NotificationJobStatus,
} from './notification-jobs.repository';

export interface OutboxStats {
  pendingCount: number;
  failedCount: number;
  oldestPendingAgeMs: number | null;
}

export interface OpsHealthSummary {
  outbox: OutboxStats;
  deadLetter: {
    unresolvedCount: number;
    unresolvedByConsumer: Array<{ consumer: string; count: number }>;
  };
  notificationJobs: Array<{ status: NotificationJobStatus; count: number }>;
}

/**
 * Sistem sağlığı ve asenkron kuyruk operasyonları (Faz 10).
 *
 * `GET /health` (Faz 1) altyapı bağımlılıklarını (Postgres/Redis) raporlar ve
 * `@Public()`'tır — orkestratör onu kimliksiz çağırır. Bu servis ise **iş**
 * kuyruklarının durumunu (outbox, DLQ, bildirim işleri) raporlar; hassas olmayan
 * ama operasyonel bir görünümdür, bu yüzden ADMIN/SUPPORT'a kapalı, herkese açık
 * değildir.
 */
@Injectable()
export class OpsService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly deadLetter: DeadLetterService,
    private readonly notificationJobs: NotificationJobsRepository,
  ) {}

  async health(): Promise<OpsHealthSummary> {
    const [outbox, unresolvedCount, unresolvedByConsumer, notificationJobCounts] =
      await Promise.all([
        this.outboxStats(),
        this.deadLetter.unresolvedCount(),
        this.deadLetter.unresolvedByConsumer(),
        this.notificationJobCounts(),
      ]);

    return {
      outbox,
      deadLetter: { unresolvedCount, unresolvedByConsumer },
      notificationJobs: notificationJobCounts,
    };
  }

  private async outboxStats(): Promise<OutboxStats> {
    const result = await this.pool.query<{
      pending_count: string;
      failed_count: string;
      oldest_pending_age_ms: string | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'PENDING') AS pending_count,
         count(*) FILTER (WHERE status = 'FAILED') AS failed_count,
         EXTRACT(EPOCH FROM (now() - min(occurred_at) FILTER (WHERE status = 'PENDING'))) * 1000
           AS oldest_pending_age_ms
       FROM outbox`,
    );
    const row = result.rows[0];
    return {
      pendingCount: parseInt(row?.pending_count ?? '0', 10),
      failedCount: parseInt(row?.failed_count ?? '0', 10),
      oldestPendingAgeMs:
        row?.oldest_pending_age_ms !== null && row?.oldest_pending_age_ms !== undefined
          ? Math.round(Number(row.oldest_pending_age_ms))
          : null,
    };
  }

  private async notificationJobCounts(): Promise<
    Array<{ status: NotificationJobStatus; count: number }>
  > {
    const result = await this.pool.query<{ status: NotificationJobStatus; count: string }>(
      `SELECT status, count(*)::text AS count FROM notification_jobs GROUP BY status`,
    );
    return result.rows.map((row) => ({ status: row.status, count: Number(row.count) }));
  }

  async listDeadLetters(filter: {
    consumer?: string;
    resolved?: boolean;
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<DeadLetterRecord[]> {
    return this.deadLetter.list(filter);
  }

  /**
   * DLQ kaydını operasyonel olarak kapatır.
   *
   * Bu, olayı **yeniden işlemez** — kalıcı hatanın kök nedeni (ör. şema uyuşmazlığı,
   * manuel düzeltme) operatör tarafından ele alındıktan sonra kaydı arşivler.
   */
  async resolveDeadLetter(id: string, actorUserId: string): Promise<void> {
    await this.uow.withTransaction(async (client) => {
      const resolved = await this.deadLetter.resolve(client, id);
      if (!resolved) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }
      // `entity_id` UUID'dir; DLQ kaydının kimliği BIGSERIAL'dır — id `newValue`'da taşınır.
      await this.audit.record(client, {
        action: AuditAction.DEAD_LETTER_EVENT_RESOLVED,
        entityType: 'dead_letter_event',
        actorUserId,
        newValue: { deadLetterEventId: id },
      });
    });
  }

  async listNotificationJobs(filter: {
    status?: NotificationJobStatus;
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<NotificationJobRecord[]> {
    return this.notificationJobs.list(filter);
  }

  /** Başarısız bir bildirim işini yeniden kuyruklar (bkz. repository doc: henüz teslimat yok). */
  async retryNotificationJob(id: string, actorUserId: string): Promise<void> {
    await this.uow.withTransaction(async (client) => {
      const retried = await this.notificationJobs.retry(client, id);
      if (!retried) {
        throw new BusinessException(ErrorCode.NOT_FOUND, {
          clientMessage: 'İş bulunamadı veya yeniden kuyruklanabilir durumda değil.',
        });
      }
      // `entity_id` UUID'dir; bildirim işi kimliği BIGSERIAL'dır — id `newValue`'da taşınır.
      await this.audit.record(client, {
        action: AuditAction.NOTIFICATION_JOB_RETRIED,
        entityType: 'notification_job',
        actorUserId,
        newValue: { notificationJobId: id },
      });
    });
  }
}
