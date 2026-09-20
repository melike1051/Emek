import { Type } from 'class-transformer';
import { IsDate, IsInt, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { MAX_RAW_TEXT_LENGTH } from '../booking-requests.constants';
import type { BookingRequestRecord, CreateFromTextOutcome } from '../booking-requests.service';

/** Serbest metin yolu. */
export class CreateRequestFromTextDto {
  @IsString()
  @MaxLength(MAX_RAW_TEXT_LENGTH)
  rawText!: string;

  @IsUUID()
  addressId!: string;
}

/**
 * Form yolu.
 *
 * AI servisine hiç dokunmaz: "AI down iken core akış çalışır" garantisi budur (T-15).
 */
export class CreateRequestFromFormDto {
  @IsUUID()
  serviceId!: string;

  @IsUUID()
  addressId!: string;

  @Type(() => Date)
  @IsDate()
  preferredStart!: Date;

  @Type(() => Date)
  @IsDate()
  preferredEnd!: Date;

  @IsInt()
  @Min(30)
  @Max(1440)
  durationMinutes!: number;
}

export class BookingRequestResponseDto {
  id!: string;
  serviceId!: string;
  addressId!: string;
  preferredStart!: string;
  preferredEnd!: string;
  durationMinutes!: number;
  status!: string;
  /** Ar-Ge izlenebilirliği: hangi parser sürümüyle üretildiği (ADR-0012 §1). */
  parserVersion!: string | null;
  parserConfidence!: number | null;

  static from(record: BookingRequestRecord): BookingRequestResponseDto {
    return {
      id: record.id,
      serviceId: record.serviceId,
      addressId: record.addressId,
      preferredStart: record.preferredStart.toISOString(),
      preferredEnd: record.preferredEnd.toISOString(),
      durationMinutes: record.durationMinutes,
      status: record.status,
      parserVersion: record.parserVersion,
      parserConfidence: record.parserConfidence === null ? null : Number(record.parserConfidence),
    };
  }
}

export class ClarificationDto {
  field!: string;
  question!: string;
  options!: string[];
}

/**
 * Serbest metin yolunun yanıtı.
 *
 * `status` üç değerden biridir; istemci buna göre davranır:
 * - `CREATED`: talep oluştu.
 * - `NEEDS_CLARIFICATION`: soruları göster.
 * - `FORM_REQUIRED`: AI erişilemiyor, doğrudan formu aç (degraded mod).
 */
export class CreateFromTextResponseDto {
  status!: 'CREATED' | 'NEEDS_CLARIFICATION' | 'FORM_REQUIRED';
  request!: BookingRequestResponseDto | null;
  parserVersion!: string | null;
  confidence!: number | null;
  clarifications!: ClarificationDto[];

  static from(outcome: CreateFromTextOutcome): CreateFromTextResponseDto {
    if (outcome.kind === 'CREATED') {
      return {
        status: 'CREATED',
        request: BookingRequestResponseDto.from(outcome.record),
        parserVersion: outcome.record.parserVersion,
        confidence:
          outcome.record.parserConfidence === null ? null : Number(outcome.record.parserConfidence),
        clarifications: [],
      };
    }

    return {
      status: outcome.degraded ? 'FORM_REQUIRED' : 'NEEDS_CLARIFICATION',
      request: null,
      parserVersion: outcome.parserVersion,
      confidence: outcome.confidence,
      clarifications: outcome.clarifications,
    };
  }
}
