import type {
  BookingStatus,
  DisputeReason,
  DisputeStatus,
  PaymentStatus,
  ProviderState,
  RecoveryStatus,
  RiskLevel,
  SafetyEventType,
} from '@emek/api-client';
import type { BadgeTone } from '@emek/ui';

export interface StatusView {
  label: string;
  tone: BadgeTone;
}

/**
 * Operatör etiketleri: kısa Türkçe ad + teknik kod (operatör log/audit ile eşleştirir).
 * Bilinmeyen değer (yeni backend durumu) ham koduyla nötr gösterilir.
 */
function view<T extends string>(map: Record<T, StatusView>) {
  return (value: string): StatusView => map[value as T] ?? { label: value, tone: 'neutral' };
}

export const providerStateView = view<ProviderState>({
  DRAFT: { label: 'Taslak', tone: 'neutral' },
  PENDING_REVIEW: { label: 'İnceleme bekliyor', tone: 'highlight' },
  APPROVED: { label: 'Onaylı', tone: 'trust' },
  REJECTED: { label: 'Reddedildi', tone: 'danger' },
  SUSPENDED: { label: 'Askıda', tone: 'danger' },
});

export const recoveryStatusView = view<RecoveryStatus>({
  PENDING_REVIEW: { label: 'İnceleme bekliyor', tone: 'highlight' },
  APPROVED: { label: 'Onaylandı', tone: 'trust' },
  REJECTED: { label: 'Reddedildi', tone: 'neutral' },
});

export const bookingStatusView = view<BookingStatus>({
  REQUESTED: { label: 'Talep', tone: 'neutral' },
  MATCHED: { label: 'Eşleşti', tone: 'neutral' },
  PROVIDER_PENDING: { label: 'Sağlayıcı onayı', tone: 'highlight' },
  CONFIRMED: { label: 'Onaylandı', tone: 'highlight' },
  PAYMENT_AUTHORIZED: { label: 'Ödeme yetkili', tone: 'trust' },
  SCHEDULED: { label: 'Planlandı', tone: 'trust' },
  PROVIDER_ARRIVING: { label: 'Yolda', tone: 'trust' },
  CHECKED_IN: { label: 'Giriş yaptı', tone: 'trust' },
  IN_PROGRESS: { label: 'Sürüyor', tone: 'trust' },
  CHECKED_OUT: { label: 'Çıkış yaptı', tone: 'highlight' },
  CUSTOMER_CONFIRMED: { label: 'Müşteri onayı', tone: 'trust' },
  COMPLETED: { label: 'Tamamlandı', tone: 'trust' },
  SETTLED: { label: 'Kapandı', tone: 'neutral' },
  CANCELLED: { label: 'İptal', tone: 'neutral' },
  DISPUTED: { label: 'Uyuşmazlık', tone: 'danger' },
  SAFETY_HOLD: { label: 'Güvenlik bekletmesi', tone: 'danger' },
});

export const BOOKING_STATUSES: BookingStatus[] = [
  'REQUESTED',
  'MATCHED',
  'PROVIDER_PENDING',
  'CONFIRMED',
  'PAYMENT_AUTHORIZED',
  'SCHEDULED',
  'PROVIDER_ARRIVING',
  'CHECKED_IN',
  'IN_PROGRESS',
  'CHECKED_OUT',
  'CUSTOMER_CONFIRMED',
  'COMPLETED',
  'SETTLED',
  'CANCELLED',
  'DISPUTED',
  'SAFETY_HOLD',
];

export const paymentStatusView = view<PaymentStatus>({
  CREATED: { label: 'Oluşturuldu', tone: 'neutral' },
  AUTHORIZED: { label: 'Yetkilendirildi', tone: 'trust' },
  HELD: { label: 'Bekletiliyor', tone: 'trust' },
  SERVICE_COMPLETED: { label: 'Hizmet tamamlandı', tone: 'highlight' },
  RELEASE_PENDING: { label: 'Serbest bırakılıyor', tone: 'highlight' },
  RELEASED: { label: 'Serbest bırakıldı', tone: 'neutral' },
  FAILED: { label: 'Başarısız', tone: 'danger' },
  REFUNDED: { label: 'İade edildi', tone: 'neutral' },
  DISPUTED: { label: 'Uyuşmazlıkta', tone: 'danger' },
  AUTHORIZATION_EXPIRED: { label: 'Yetki süresi doldu', tone: 'danger' },
});

export const PAYMENT_STATUSES: PaymentStatus[] = [
  'CREATED',
  'AUTHORIZED',
  'HELD',
  'SERVICE_COMPLETED',
  'RELEASE_PENDING',
  'RELEASED',
  'FAILED',
  'REFUNDED',
  'DISPUTED',
  'AUTHORIZATION_EXPIRED',
];

export const disputeStatusView = view<DisputeStatus>({
  OPEN: { label: 'Açık', tone: 'danger' },
  UNDER_REVIEW: { label: 'İnceleniyor', tone: 'highlight' },
  RESOLVED_CUSTOMER: { label: 'Müşteri lehine', tone: 'neutral' },
  RESOLVED_PROVIDER: { label: 'Sağlayıcı lehine', tone: 'neutral' },
  WITHDRAWN: { label: 'Geri çekildi', tone: 'neutral' },
});

export const DISPUTE_REASON_LABEL: Record<DisputeReason, string> = {
  SERVICE_NOT_PERFORMED: 'Hizmet yapılmadı',
  SERVICE_QUALITY: 'Hizmet kalitesi',
  DAMAGE: 'Hasar',
  BILLING: 'Ücretlendirme',
  SAFETY: 'Güvenlik',
  OTHER: 'Diğer',
};

export const riskView = view<RiskLevel>({
  NORMAL: { label: 'Normal', tone: 'trust' },
  WARNING: { label: 'Uyarı', tone: 'highlight' },
  HIGH_RISK: { label: 'Yüksek risk', tone: 'danger' },
  EMERGENCY: { label: 'Acil durum', tone: 'danger' },
});

export const RISK_LEVELS: RiskLevel[] = ['NORMAL', 'WARNING', 'HIGH_RISK', 'EMERGENCY'];

export const SAFETY_EVENT_TYPES: SafetyEventType[] = [
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
];
