import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import type { MatchOutcome } from '../matching.service';

/**
 * Toplu eşleştirme isteği (operasyon).
 *
 * Üst sınır sözleşme seviyesinde de var: `MATCHING_BATCH_LIMIT` çalışma zamanı
 * kontrolüdür, bu ise istemciye net geri bildirim verir ve gereksiz iş yapılmaz.
 */
export class MatchBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  /**
   * Tekrar eden talep kimliği reddedilir.
   *
   * Aynı talep iki kez gönderilseydi hazırlık iki kez çalışır ve — motor kendi
   * tekillik kontrolüyle isteği reddettiği için — yedek yolda **tek talep için iki
   * rezervasyon** oluşabilirdi. Servis ayrıca kümeyi tekilleştirir; bu kontrol
   * istemciye net geri bildirim verir.
   */
  @ArrayUnique()
  @IsUUID('4', { each: true })
  @Type(() => String)
  requestIds!: string[];
}

/**
 * Müşteriye dönen eşleştirme sonucu.
 *
 * **Ne dönmediği** en az ne döndüğü kadar önemlidir (T-19, ADR-0007 §6):
 *
 * - Değerlendirilen diğer adayların kimlikleri **yoktur**. Müşteriye "şu 9 sağlayıcı
 *   da müsaitti" demek, o sağlayıcıların takvimini ve konum bilgisini sızdırmaktır.
 * - Ham skor bileşenleri **yoktur**. Skorlar iç karar verisidir; dışarı verilmesi
 *   hem sıralamayı oyunlaştırmaya (skor mühendisliği) hem de sağlayıcılar arası
 *   karşılaştırmalı veri sızıntısına açık kapı bırakır.
 * - Açıklama **kapalı kod kümesidir**: istemci metni kendi diliyle üretir.
 *
 * Operasyon (ADR) tarafı tam sıralamayı ayrı bir uçtan görür.
 */
export class MatchResultResponseDto {
  requestId!: string;
  runId!: string;
  status!: 'MATCHED' | 'NO_CANDIDATE';
  /** Bozulmuş modda üretilen sonuç işaretlenir (T-16). */
  degraded!: boolean;
  bookingId!: string | null;
  providerId!: string | null;
  providerName!: string | null;
  scheduledStart!: string | null;
  scheduledEnd!: string | null;
  explanation!: { code: string; value: number | null }[];

  static from(outcome: MatchOutcome): MatchResultResponseDto {
    return {
      requestId: outcome.requestId,
      runId: outcome.runId,
      status: outcome.bookingId === null ? 'NO_CANDIDATE' : 'MATCHED',
      degraded: outcome.degradedReason !== null,
      bookingId: outcome.bookingId,
      providerId: outcome.selectedProviderId,
      providerName: outcome.selectedProviderName,
      scheduledStart: outcome.scheduledStart?.toISOString() ?? null,
      scheduledEnd: outcome.scheduledEnd?.toISOString() ?? null,
      explanation: outcome.explanation,
    };
  }
}

/**
 * Operasyon görünümü: tam sıralama ve skor bileşenleri.
 *
 * Yalnızca `ADMIN` erişir. Ar-Ge ve destek için gereken tek görünüm budur; müşteri
 * ve sağlayıcı uçlarından erişilemez.
 */
export class MatchRunCandidateDto {
  providerId!: string;
  rank!: number;
  overallScore!: number;
  components!: Record<string, number>;
  selected!: boolean;
  distanceMeters!: number;
  travelSeconds!: number;
  proposedStart!: string | null;
  proposedEnd!: string | null;
  explanation!: { code: string; value: number | null }[];
}

export class MatchRunResponseDto {
  runId!: string;
  requestId!: string;
  algorithmVersion!: string;
  weightsVersion!: string;
  objectiveVersion!: string;
  strategy!: string;
  degradedReason!: string | null;
  candidateCount!: number;
  eligibleCount!: number;
  createdAt!: string;
  candidates!: MatchRunCandidateDto[];
}
