import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CursorQueryDto } from '../../common/pagination/cursor-query.dto';
import { VERIFICATION_PURPOSES, type VerificationPurpose } from '../identity.types';

const RECOVERY_REQUEST_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const;
type RecoveryRequestStatus = (typeof RECOVERY_REQUEST_STATUSES)[number];

export class StartVerificationDto {
  /** Sağlayıcının desteklediği yöntem; geçersiz değer desteklenenlerle birlikte reddedilir. */
  @IsString()
  @MaxLength(40)
  method!: string;

  @IsOptional()
  @IsIn(VERIFICATION_PURPOSES)
  purpose?: VerificationPurpose;
}

export class StartVerificationResponseDto {
  attemptId!: string;
  clientToken!: string;
  expiresAt!: string;
  method!: string;
  purpose!: string;
}

export class VerificationAttemptResponseDto {
  id!: string;
  status!: string;
  purpose!: string;
  method!: string;
  resultCode!: string | null;
  assuranceLevel!: string | null;
  createdAt!: string;
  expiresAt!: string;
  completedAt!: string | null;
}

export class IdentityStatusResponseDto {
  level!: string;
  identityVerified!: boolean;
  assuranceLevel!: string | null;
  verifiedAt!: string | null;
  provider!: string | null;
}

export class VerificationCallbackResponseDto {
  status!: string;
}

// --- Admin: kurtarma kuyruğu (Faz 10) ---

export class RecoveryQueueQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(RECOVERY_REQUEST_STATUSES)
  status?: RecoveryRequestStatus;
}

export class RecoveryRequestResponseDto {
  id!: string;
  requesterUserId!: string;
  targetUserId!: string;
  status!: RecoveryRequestStatus;
  assuranceLevel!: string;
  createdAt!: string;
  decidedAt!: string | null;
  decidedBy!: string | null;
  decisionReason!: string | null;

  static from(record: {
    id: string;
    requesterUserId: string;
    targetUserId: string;
    status: RecoveryRequestStatus;
    assuranceLevel: string;
    createdAt: Date;
    decidedAt: Date | null;
    decidedBy: string | null;
    decisionReason: string | null;
  }): RecoveryRequestResponseDto {
    return {
      id: record.id,
      requesterUserId: record.requesterUserId,
      targetUserId: record.targetUserId,
      status: record.status,
      assuranceLevel: record.assuranceLevel,
      createdAt: record.createdAt.toISOString(),
      decidedAt: record.decidedAt?.toISOString() ?? null,
      decidedBy: record.decidedBy,
      decisionReason: record.decisionReason,
    };
  }
}

export class RecoveryQueueResponseDto {
  items!: RecoveryRequestResponseDto[];
  nextCursor!: string | null;
}

export class ApproveRecoveryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RejectRecoveryDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class RecoveryDecisionResponseDto {
  recoveredUserId?: string;
  status!: 'APPROVED' | 'REJECTED';
}
