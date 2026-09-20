/**
 * NLP portu (ADR-0007).
 *
 * Core, AI servisinin **ne olduğunu** bilmez: kural tabanlı bir parser da olabilir,
 * bir model servisi de. Bildiği tek şey "serbest metin → doğrulanmış talep" dönüşümü
 * ve bu dönüşümün **başarısız olabileceğidir**.
 *
 * Kritik kural: NLP bir **öneridir**, karar değil. Çıktısı core'un kendi
 * doğrulamasından ve yetki kontrollerinden geçer; doğrudan iş kuralına girmez.
 */

export const SERVICE_SLUGS = [
  'standart-temizlik',
  'detayli-temizlik',
  'tasinma-temizligi',
  'yasli-bakimi',
  'cocuk-bakimi',
  'hasta-refakati',
  'gunluk-yemek',
  'haftalik-mealprep',
] as const;

export type ServiceSlug = (typeof SERVICE_SLUGS)[number];

export interface NlpTimeWindow {
  startHour: number;
  endHour: number;
}

export interface NlpStructuredRequest {
  serviceType: ServiceSlug;
  durationMinutes: number;
  serviceDate: string | null;
  timeWindow: NlpTimeWindow | null;
  requirements: string[];
}

export interface NlpClarification {
  field: string;
  question: string;
  options: string[];
}

export type NlpParseOutcome =
  | {
      status: 'PARSED';
      parserVersion: string;
      confidence: number;
      request: NlpStructuredRequest;
    }
  | {
      status: 'NEEDS_CLARIFICATION';
      parserVersion: string;
      confidence: number;
      request: NlpStructuredRequest | null;
      clarifications: NlpClarification[];
    }
  /** Servise ulaşılamadı veya yanıt sözleşmeye uymadı: çağıran form yoluna düşer. */
  | { status: 'UNAVAILABLE'; reason: 'TIMEOUT' | 'TRANSPORT' | 'INVALID_RESPONSE' };

export interface NlpClient {
  parse(input: { rawText: string; today?: Date }): Promise<NlpParseOutcome>;
}

export const NLP_CLIENT = Symbol('NLP_CLIENT');
