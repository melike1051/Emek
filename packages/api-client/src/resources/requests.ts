import { pathSegment, type ApiClient } from '../client';

/** Kaynak: services/api/src/requests/dto/booking-request.dto.ts (BookingRequestResponseDto). */
export interface BookingRequest {
  id: string;
  serviceId: string;
  addressId: string;
  preferredStart: string;
  preferredEnd: string;
  durationMinutes: number;
  status: string;
  /** Ar-Ge izlenebilirliği (ADR-0012 §1); form yolunda `null`. */
  parserVersion: string | null;
  parserConfidence: number | null;
}

/** Kaynak: ClarificationDto. */
export interface Clarification {
  field: string;
  question: string;
  options: string[];
}

/**
 * Kaynak: CreateFromTextResponseDto.
 * `FORM_REQUIRED`: AI erişilemiyor — istemci doğrudan formu açar (T-15).
 */
export interface CreateFromTextResult {
  status: 'CREATED' | 'NEEDS_CLARIFICATION' | 'FORM_REQUIRED';
  request: BookingRequest | null;
  parserVersion: string | null;
  confidence: number | null;
  clarifications: Clarification[];
}

/** Kaynak: CreateRequestFromTextDto — rawText ≤ MAX_RAW_TEXT_LENGTH. */
export interface CreateFromTextInput {
  rawText: string;
  addressId: string;
}

/** Kaynak: CreateRequestFromFormDto — durationMinutes 30..1440, tarih ISO metni. */
export interface CreateFromFormInput {
  serviceId: string;
  addressId: string;
  preferredStart: string;
  preferredEnd: string;
  durationMinutes: number;
}

/** Kaynak: services/ai/app/matching/schema.py (ExplanationCode) — kapalı küme. */
export type ExplanationCode =
  | 'ALL_REQUIRED_SKILLS_VERIFIED'
  | 'EXPERT_LEVEL_SKILLS'
  | 'PREFERRED_SKILLS_MATCHED'
  | 'PREFERRED_SKILLS_PARTIAL'
  | 'FULL_WINDOW_AVAILABLE'
  | 'PARTIAL_WINDOW_AVAILABLE'
  | 'NEARBY'
  | 'WITHIN_SERVICE_AREA'
  | 'HIGH_RATING'
  | 'LIMITED_RATING_HISTORY'
  | 'EXPERIENCED';

/**
 * Kaynak: services/api/src/matching/dto/matching.dto.ts (MatchResultResponseDto).
 * Yalnızca **seçilen** sağlayıcı döner; diğer adaylar ve ham skorlar yoktur (T-19).
 * Eşleşme başarılıysa rezervasyon backend'de oluşturulmuştur (`bookingId`).
 */
export interface MatchResult {
  requestId: string;
  runId: string;
  status: 'MATCHED' | 'NO_CANDIDATE';
  degraded: boolean;
  bookingId: string | null;
  providerId: string | null;
  providerName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  explanation: { code: ExplanationCode | (string & {}); value: number | null }[];
}

export function requestsApi(client: ApiClient) {
  return {
    fromText: (body: CreateFromTextInput) =>
      client.post<CreateFromTextResult>('/booking-requests/from-text', body),
    fromForm: (body: CreateFromFormInput) => client.post<BookingRequest>('/booking-requests', body),
    get: (id: string) => client.get<BookingRequest>(`/booking-requests/${pathSegment(id)}`),
    /** `idempotencyKey`: aynı kullanıcı eyleminin tekrarında aynı anahtar (client.ts). */
    match: (id: string, idempotencyKey: string) =>
      client.post<MatchResult>(`/booking-requests/${pathSegment(id)}/match`, undefined, {
        idempotencyKey,
      }),
    matchResult: (id: string) =>
      client.get<MatchResult>(`/booking-requests/${pathSegment(id)}/match`),
  };
}
