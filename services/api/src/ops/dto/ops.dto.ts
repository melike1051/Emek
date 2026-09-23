import { IsIn, IsOptional, IsString } from 'class-validator';
import { CursorQueryDto } from '../../common/pagination/cursor-query.dto';
import type { DeadLetterRecord } from '../../common/events/dead-letter.service';
import type { NotificationJobRecord, NotificationJobStatus } from '../notification-jobs.repository';
import type { OpsHealthSummary } from '../ops.service';

const NOTIFICATION_JOB_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;

export class OpsHealthResponseDto {
  outbox!: { pendingCount: number; failedCount: number; oldestPendingAgeMs: number | null };
  deadLetter!: {
    unresolvedCount: number;
    unresolvedByConsumer: Array<{ consumer: string; count: number }>;
  };
  notificationJobs!: Array<{ status: string; count: number }>;

  static from(summary: OpsHealthSummary): OpsHealthResponseDto {
    return summary;
  }
}

export class DeadLetterQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsString()
  consumer?: string;

  /**
   * `'true'`/`'false'` string olarak alınır: `@IsBoolean()` + `@Type(() => Boolean)`
   * query string'lerinde `Boolean('false') === true` tuzağına düşer (safety.controller.ts
   * `breakGlass` ile aynı desen).
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  resolved?: 'true' | 'false';
}

export class DeadLetterResponseDto {
  id!: string;
  eventId!: string;
  eventType!: string;
  eventVersion!: number;
  consumer!: string;
  payload!: Record<string, unknown>;
  attemptCount!: number;
  failureClassification!: string;
  failureReason!: string;
  firstFailureAt!: string;
  lastFailureAt!: string;
  resolvedAt!: string | null;
  createdAt!: string;

  static from(record: DeadLetterRecord): DeadLetterResponseDto {
    return {
      id: record.id,
      eventId: record.eventId,
      eventType: record.eventType,
      eventVersion: record.eventVersion,
      consumer: record.consumer,
      payload: record.payload,
      attemptCount: record.attemptCount,
      failureClassification: record.failureClassification,
      failureReason: record.failureReason,
      firstFailureAt: record.firstFailureAt.toISOString(),
      lastFailureAt: record.lastFailureAt.toISOString(),
      resolvedAt: record.resolvedAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
    };
  }
}

export class DeadLetterListResponseDto {
  items!: DeadLetterResponseDto[];
  nextCursor!: string | null;
}

export class NotificationJobQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(NOTIFICATION_JOB_STATUSES)
  status?: NotificationJobStatus;
}

export class NotificationJobResponseDto {
  id!: string;
  eventId!: string;
  eventType!: string;
  channel!: string;
  recipientUserId!: string;
  templateKey!: string;
  status!: string;
  attempts!: number;
  lastError!: string | null;
  createdAt!: string;
  sentAt!: string | null;

  static from(record: NotificationJobRecord): NotificationJobResponseDto {
    return {
      id: record.id,
      eventId: record.eventId,
      eventType: record.eventType,
      channel: record.channel,
      recipientUserId: record.recipientUserId,
      templateKey: record.templateKey,
      status: record.status,
      attempts: record.attempts,
      lastError: record.lastError,
      createdAt: record.createdAt.toISOString(),
      sentAt: record.sentAt?.toISOString() ?? null,
    };
  }
}

export class NotificationJobListResponseDto {
  items!: NotificationJobResponseDto[];
  nextCursor!: string | null;
}

/**
 * Audit zinciri doğrulama sonucu (Faz 12).
 *
 * `status` operasyonel bir bulgudur, HTTP hatası değil: kopukluk tespit edildiğinde
 * uç 200 döner ve bulguyu **gösterir**. Hata olarak dönmek, operatörün bulguyu
 * göremeden generic bir 500 görmesine yol açardı.
 */
export class AuditChainStatusResponseDto {
  status!: 'OK' | 'BROKEN';
  rowsVerified!: number;
  verifiedThroughId!: string | null;
  brokenAtId!: string | null;
  exportedStorageKey!: string | null;
}

/** Retention taramasının sildiği/anonimleştirdiği satır sayıları (Faz 12). */
export class RetentionSweepResponseDto {
  anonymizedUsers!: number;
  processedEvents!: number;
  deadLetterEvents!: number;
  verificationAttempts!: number;
  analyticsEvents!: number;
}
