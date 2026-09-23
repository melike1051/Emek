import { IsIn, IsOptional } from 'class-validator';
import { CursorQueryDto } from '../../common/pagination/cursor-query.dto';
import type {
  DiscrepancyType,
  ReconciliationDiscrepancyRecord,
  ReconciliationRunSummary,
} from '../reconciliation.service';

const DISCREPANCY_TYPES = [
  'STUCK_PENDING_COMMAND',
  'AUTHORIZATION_EXPIRED_UNHANDLED',
  'RELEASE_PENDING_STALLED',
] as const;

export class ReconciliationDiscrepancyQueryDto extends CursorQueryDto {
  /** bkz. `ops.dto.ts` `DeadLetterQueryDto.resolved` — query string boolean tuzağı. */
  @IsOptional()
  @IsIn(['true', 'false'])
  resolved?: 'true' | 'false';

  @IsOptional()
  @IsIn(DISCREPANCY_TYPES)
  discrepancyType?: DiscrepancyType;
}

export class ReconciliationDiscrepancyResponseDto {
  id!: string;
  runId!: string;
  paymentId!: string;
  discrepancyType!: string;
  details!: Record<string, unknown>;
  detectedAt!: string;
  resolvedAt!: string | null;
  resolvedBy!: string | null;

  static from(record: ReconciliationDiscrepancyRecord): ReconciliationDiscrepancyResponseDto {
    return {
      id: record.id,
      runId: record.runId,
      paymentId: record.paymentId,
      discrepancyType: record.discrepancyType,
      details: record.details,
      detectedAt: record.detectedAt.toISOString(),
      resolvedAt: record.resolvedAt?.toISOString() ?? null,
      resolvedBy: record.resolvedBy,
    };
  }
}

export class ReconciliationDiscrepancyListResponseDto {
  items!: ReconciliationDiscrepancyResponseDto[];
  nextCursor!: string | null;
}

export class ReconciliationRunResponseDto {
  runId!: string;
  checkedCount!: number;
  discrepancyCount!: number;
  newDiscrepancyCount!: number;

  static from(summary: ReconciliationRunSummary): ReconciliationRunResponseDto {
    return summary;
  }
}

export class AnalyticsExportStatusResponseDto {
  unexportedCount!: number;
  oldestUnexportedAgeMs!: number | null;
  lastExportedAt!: string | null;
}
