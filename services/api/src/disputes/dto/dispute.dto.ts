import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CursorQueryDto } from '../../common/pagination/cursor-query.dto';
import {
  DISPUTE_REASONS,
  type Dispute,
  type DisputeReason,
  type DisputeStatus,
} from '../disputes.service';

const DISPUTE_STATUSES = [
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED_CUSTOMER',
  'RESOLVED_PROVIDER',
  'WITHDRAWN',
] as const;

export class OpenDisputeDto {
  @IsIn(DISPUTE_REASONS)
  reason!: DisputeReason;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class ResolveDisputeDto {
  @IsIn(['RESOLVED_CUSTOMER', 'RESOLVED_PROVIDER', 'WITHDRAWN'])
  status!: 'RESOLVED_CUSTOMER' | 'RESOLVED_PROVIDER' | 'WITHDRAWN';

  @IsString()
  @MaxLength(2000)
  resolution!: string;

  /**
   * Karar gereği iade edilecek tutar (minor unit, string). Para hareketi ayrı bir
   * `refund` çağrısıdır; burada yalnızca karar kaydedilir.
   */
  @IsOptional()
  @Matches(/^[0-9]{1,19}$/, { message: 'refundAmountMinor tam sayı metni olmalı' })
  refundAmountMinor?: string;
}

export class DisputeResponseDto {
  id!: string;
  bookingId!: string;
  reason!: string;
  description!: string | null;
  status!: string;
  resolution!: string | null;
  refundAmountMinor!: string | null;
  createdAt!: string;
  resolvedAt!: string | null;

  static from(dispute: Dispute): DisputeResponseDto {
    return {
      id: dispute.id,
      bookingId: dispute.bookingId,
      reason: dispute.reason,
      description: dispute.description,
      status: dispute.status,
      resolution: dispute.resolution,
      refundAmountMinor: dispute.refundAmountMinor,
      createdAt: dispute.createdAt.toISOString(),
      resolvedAt: dispute.resolvedAt?.toISOString() ?? null,
      // `openedBy`/`resolvedBy` istemciye verilmez: karşı tarafa "kim şikâyet etti"
      // bilgisini vermek gereksiz bir çatışma yüzeyidir; operasyon audit'ten görür.
    };
  }
}

// --- Admin: uyuşmazlık kuyruğu (Faz 10) ---

export class AdminDisputeQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(DISPUTE_STATUSES)
  status?: DisputeStatus;
}

export class AdminDisputeListResponseDto {
  items!: DisputeResponseDto[];
  nextCursor!: string | null;
}
