/**
 * Anomali portu (ADR-0002, ADR-0008 §2, ADR-0019 §7).
 *
 * NLP ve matching portlarıyla **aynı** sözleşme: AI servisi bir öneri üretir,
 * kararı core verir. Buradaki sınır daha da katıdır çünkü konu güvenliktir:
 *
 * - Model **hiçbir koşulda** `EMERGENCY` üretemez; skoru risk toplamasına
 *   `WARNING` tavanıyla ve kalite kapısıyla girer (`risk-aggregation.ts`).
 * - Model erişilemezse değerlendirme **yine yapılır**: deterministik kurallar
 *   modelden bağımsızdır; panik bu portu hiç kullanmaz.
 * - AI servisi veritabanına dokunmaz; kalıcılık, yetki ve geçişler core'undur.
 *
 * Porta giden veri minimumdur: ham konum dizisi değil, **türetilmiş sinyaller**.
 * Koordinat yalnızca varış aşamasında ve yalnızca **iki nokta** (son konum ve
 * hizmet noktası) olarak gider; o da rota tahmini içindir (Faz 7 routing portu).
 * Tam iz göndermek, güvenlik verisini gereksizce ikinci bir servise kopyalamak olurdu.
 */

export interface AnomalyFeatures {
  sessionStatus: 'ARRIVAL_MONITORING' | 'ACTIVE';
  telemetryIntervalSeconds: number;
  plannedDurationSeconds: number;
  /** Varış aşamasında planlanan başlangıca göre fark; negatif = henüz vakit var. */
  arrivalDelaySeconds: number | null;
  /** Aktif hizmette check-in'den bu yana geçen süre. */
  elapsedActiveSeconds: number | null;

  geofenceState: string;
  geofenceStateSeconds: number | null;

  secondsSinceTelemetry: number | null;
  telemetryCount: number;
  rejectedCount: number;
  integrityRejectionCount: number;
  mockLocationCount: number;

  lastDistanceMeters: number | null;
  recentMovementMeters: number | null;
  recentWindowSeconds: number | null;
  distanceTrendMeters: number | null;
  /** Oturum geçmişi: son pencerede uzun boşluk ve çıkış sayısı. */
  recentLongGapCount: number | null;
  recentExitCount: number | null;

  /** Rota tahmini için iki nokta; yalnızca varış aşamasında ve son konum biliniyorsa. */
  route: {
    origin: { latitude: number; longitude: number };
    destination: { latitude: number; longitude: number };
  } | null;
}

export interface AnomalyContribution {
  /** Özellik adı — kapalı küme; model iç detayı değil, okunabilir sinyal adı. */
  feature: string;
  /** Bu özelliğin skora katkısı [0, 1]. */
  contribution: number;
}

export interface RouteEstimate {
  etaSeconds: number;
  distanceMeters: number;
  /** Tahmini üreten kaynak (ör. `haversine`) — gerçek rota iddiası taşımaz. */
  provider: string;
}

export interface AnomalyAssessment {
  anomalyScore: number;
  modelVersion: string;
  /** Skora en çok katkı veren sinyaller — açıklanabilirlik. */
  contributions: AnomalyContribution[];
  /**
   * Değerlendirmenin veri kalitesi [0, 1]: uygulanabilir özelliklerin ne kadarının
   * gerçekten ölçülebildiği. Düşük kalite, yüksek skoru **zayıf** kanıt yapar.
   */
  quality: number;
  /** Modelin okuyamadığı özellikler. */
  unavailableFeatures: string[];
  /** Rota tahmini; istenmediyse ya da kullanılamadıysa `null`. */
  route: RouteEstimate | null;
}

export const ANOMALY_UNAVAILABLE_REASONS = [
  'TIMEOUT',
  'TRANSPORT',
  /** 5xx: servis hata döndürdü (işletme durumu). */
  'SERVER_ERROR',
  /** 2xx ama JSON değil ya da şemaya uymuyor. */
  'INVALID_RESPONSE',
  /** 4xx (408/429 hariç): sözleşme ayrışması ya da servis anahtarı hatası. */
  'CONTRACT_MISMATCH',
  /** Art arda altyapı hatası sonrası çağrı yapılmadı (devre kesici açık). */
  'CIRCUIT_OPEN',
] as const;
export type AnomalyUnavailableReason = (typeof ANOMALY_UNAVAILABLE_REASONS)[number];

export type AnomalyOutcome =
  | { status: 'ASSESSED'; assessment: AnomalyAssessment }
  /**
   * Model kullanılamadı. Ayrım korunur çünkü nedenleri farklı davranış gerektirir:
   * `CONTRACT_MISMATCH` (4xx) bir **hatadır** — şemalar ayrışmıştır ve kesinti gibi
   * raporlanırsa sistem sonsuza dek modelsiz çalışırken kimse fark etmez; diğerleri
   * işletme durumudur (Faz 7 dersi).
   */
  | { status: 'UNAVAILABLE'; reason: AnomalyUnavailableReason };

export interface AnomalyClient {
  assess(features: AnomalyFeatures): Promise<AnomalyOutcome>;
}

export const ANOMALY_CLIENT = Symbol('ANOMALY_CLIENT');
