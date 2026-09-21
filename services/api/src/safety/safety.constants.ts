/**
 * Safety domain sabitleri — veritabanı enum'larıyla birebir aynı (ADR-0008).
 *
 * Kümeler kapalıdır: serbest metin bir risk seviyesi ya da olay tipi yazılamaz.
 * Rapor, alarm ve operatör görünümü bu kümelere dayanır.
 */

/**
 * Oturum yaşam döngüsü.
 *
 * `NOT_STARTED` şemada var ama uygulama bir oturumu doğrudan `PRE_SERVICE` olarak
 * açar: "oturum kaydı var ama başlamadı" durumu, telemetrinin kabul edilip
 * edilmeyeceği sorusuna ikinci bir cevap üretirdi. Enum'da bırakılmasının nedeni
 * ileride operatörün oturumu önceden hazırlaması gereken bir akış çıkarsa
 * şemayı değiştirmek zorunda kalmamaktır.
 */
export const SAFETY_SESSION_STATUSES = [
  'NOT_STARTED',
  'PRE_SERVICE',
  'ARRIVAL_MONITORING',
  'ACTIVE',
  'CLOSED',
] as const;
export type SafetySessionStatus = (typeof SAFETY_SESSION_STATUSES)[number];

/**
 * Telemetrinin **kabul edildiği** tek durumlar.
 *
 * Bu küme, "24 saat takip yok" ilkesinin koddaki karşılığıdır: oturum bu iki
 * durumda değilse konum verisi reddedilir, saklanmaz ve değerlendirmeye girmez
 * (T-23).
 */
export const TELEMETRY_ACCEPTING_STATUSES: readonly SafetySessionStatus[] = [
  'ARRIVAL_MONITORING',
  'ACTIVE',
];

export function acceptsTelemetry(status: SafetySessionStatus): boolean {
  return TELEMETRY_ACCEPTING_STATUSES.includes(status);
}

export const RISK_LEVELS = ['NORMAL', 'WARNING', 'HIGH_RISK', 'EMERGENCY'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Karşılaştırma için sıra. Toplama "en yüksek kazanır" ile yapılır. */
const RISK_ORDER: Record<RiskLevel, number> = {
  NORMAL: 0,
  WARNING: 1,
  HIGH_RISK: 2,
  EMERGENCY: 3,
};

export function riskRank(level: RiskLevel): number {
  return RISK_ORDER[level];
}

export function maxRisk(first: RiskLevel, second: RiskLevel): RiskLevel {
  return riskRank(first) >= riskRank(second) ? first : second;
}

export const GEOFENCE_STATES = [
  'UNKNOWN',
  'INSIDE',
  'OUTSIDE',
  'BOUNDARY',
  'INSUFFICIENT_ACCURACY',
] as const;
export type GeofenceState = (typeof GEOFENCE_STATES)[number];

/**
 * Kesin bir konum yargısı taşıyan durumlar.
 *
 * `BOUNDARY` ve `INSUFFICIENT_ACCURACY` bilinçli olarak dışarıdadır: ikisi de
 * "bilmiyoruz" demektir ve kural motoru bunları ihlal saymaz. Zayıf GPS sinyalini
 * "dışarıda" saymak, kapalı alanda çalışan bir sağlayıcıyı kaçmış gibi gösterirdi.
 */
export function isConclusiveGeofence(state: GeofenceState): boolean {
  return state === 'INSIDE' || state === 'OUTSIDE';
}

export const SAFETY_EVENT_SOURCES = ['RULE', 'ML', 'USER', 'SYSTEM', 'OPERATOR'] as const;
export type SafetyEventSource = (typeof SAFETY_EVENT_SOURCES)[number];

export const SAFETY_EVENT_TYPES = [
  'SESSION_STARTED',
  'ARRIVAL_MONITORING_STARTED',
  'SESSION_ACTIVATED',
  'GEOFENCE_ENTERED',
  'GEOFENCE_EXITED',
  'TELEMETRY_REJECTED',
  'TELEMETRY_REANCHORED',
  'RULE_TRIGGERED',
  'ANOMALY_FLAGGED',
  'RISK_ESCALATED',
  'RISK_DEESCALATED',
  'RISK_OVERRIDDEN',
  'PANIC_RAISED',
  'SESSION_CLOSED',
] as const;
export type SafetyEventType = (typeof SAFETY_EVENT_TYPES)[number];

export const SAFETY_CLOSURE_REASONS = [
  'SERVICE_COMPLETED',
  'BOOKING_CANCELLED',
  'EXPIRED',
  'OPERATOR_CLOSED',
] as const;
export type SafetyClosureReason = (typeof SAFETY_CLOSURE_REASONS)[number];

/**
 * Telemetrinin reddedilme nedenleri.
 *
 * Kapalı küme olması önemli: ret oranı ölçülen bir metriktir
 * (research-metrics §2.4) ve "neden reddedildi" sorusu serbest metinle
 * yanıtlanırsa gruplanamaz. Reddedilen örnek **sessizce kaybolmaz**: sayaç artar
 * ve bütünlük retleri güvenlik olayına yazılır (ADR-0008 §2).
 */
export const TELEMETRY_REJECTION_REASONS = [
  /** Sıra numarası daha önce görüldü: ağ yeniden denemesi ya da replay. */
  'SEQUENCE_REPLAY',
  /** İstemci saati sunucunun izin verdiğinden ileride. */
  'CLOCK_SKEW_FUTURE',
  /** Örnek, gecikmeli teslim penceresinden de eski. */
  'CLOCK_SKEW_STALE',
  /** Örnek, izlemenin başlamasından önce alınmış: amaç sınırlaması. */
  'CAPTURED_BEFORE_SESSION',
  /** Sıra ilerledi ama zaman geri gitti: saat manipülasyonu ya da bozuk cihaz. */
  'CLOCK_REGRESSION',
  /** Örnekler arası süre asgari aralığın altında: taşma/flood koruması. */
  'TOO_FREQUENT',
  /** Doğruluk daireleri düşüldükten sonra bile fiziksel olarak imkânsız hız. */
  'IMPOSSIBLE_SPEED',
] as const;
export type TelemetryRejectionReason = (typeof TELEMETRY_REJECTION_REASONS)[number];

/**
 * Bütünlük ihlali sayılan retler.
 *
 * Replay, bayat ve sık örnek bu kümede **değildir**: ağ yeniden denemesi ve cihaz
 * uykusu olağandır ve bunları "şüpheli" saymak dürüst kullanıcıyı işaretlerdi.
 */
export const INTEGRITY_REJECTION_REASONS: readonly TelemetryRejectionReason[] = [
  'CLOCK_SKEW_FUTURE',
  'CLOCK_REGRESSION',
  'IMPOSSIBLE_SPEED',
];

export function isIntegrityRejection(reason: TelemetryRejectionReason): boolean {
  return INTEGRITY_REJECTION_REASONS.includes(reason);
}
