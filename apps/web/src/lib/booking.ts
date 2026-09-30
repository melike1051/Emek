import type {
  BookingStatus,
  DisputeReason,
  DisputeStatus,
  DocumentType,
  ExplanationCode,
  PaymentStatus,
} from '@emek/api-client';
import type { BadgeTone } from '@emek/ui';

interface StatusView {
  label: string;
  tone: BadgeTone;
}

/** Müşteri diliyle durum etiketleri; teknik ad (ör. `PROVIDER_PENDING`) kullanıcıya gösterilmez. */
export const BOOKING_STATUS_VIEW: Record<BookingStatus, StatusView> = {
  REQUESTED: { label: 'Talep alındı', tone: 'neutral' },
  MATCHED: { label: 'Eşleşti', tone: 'neutral' },
  PROVIDER_PENDING: { label: 'Sağlayıcı onayı bekleniyor', tone: 'highlight' },
  CONFIRMED: { label: 'Onaylandı — ödeme bekleniyor', tone: 'highlight' },
  PAYMENT_AUTHORIZED: { label: 'Ödeme alındı', tone: 'trust' },
  SCHEDULED: { label: 'Planlandı', tone: 'trust' },
  PROVIDER_ARRIVING: { label: 'Sağlayıcı yolda', tone: 'trust' },
  CHECKED_IN: { label: 'Sağlayıcı geldi', tone: 'trust' },
  IN_PROGRESS: { label: 'Hizmet sürüyor', tone: 'trust' },
  CHECKED_OUT: { label: 'Onayınız bekleniyor', tone: 'highlight' },
  CUSTOMER_CONFIRMED: { label: 'Onayladınız', tone: 'trust' },
  COMPLETED: { label: 'Tamamlandı', tone: 'trust' },
  SETTLED: { label: 'Kapandı', tone: 'neutral' },
  CANCELLED: { label: 'İptal edildi', tone: 'neutral' },
  DISPUTED: { label: 'İtiraz inceleniyor', tone: 'danger' },
  SAFETY_HOLD: { label: 'Güvenlik incelemesi', tone: 'danger' },
};

export function bookingStatusView(status: string): StatusView {
  return BOOKING_STATUS_VIEW[status as BookingStatus] ?? { label: status, tone: 'neutral' };
}

/** Geçmiş sekmesine düşen, akışı bitmiş durumlar. */
const TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'SETTLED', 'CANCELLED']);

export function isActiveBooking(status: string): boolean {
  return !TERMINAL.has(status);
}

/**
 * Müşterinin bu durumda yapabilecekleri — backend transition map'inin (ADR-0006) **aynası**dır,
 * yetki kaynağı değildir: backend her komutu ayrıca doğrular ve reddi ekranda gösterilir.
 */
export interface CustomerActions {
  canPay: boolean;
  canCancel: boolean;
  canConfirmService: boolean;
  canReview: boolean;
  canDispute: boolean;
  /** Güvenlik oturumu ekranı anlamlı mı (hizmet günü akışı). */
  hasSafetySession: boolean;
}

const CANCELLABLE_BY_PARTY: ReadonlySet<string> = new Set([
  'REQUESTED',
  'MATCHED',
  'PROVIDER_PENDING',
  'CONFIRMED',
  'PAYMENT_AUTHORIZED',
  'SCHEDULED',
  'PROVIDER_ARRIVING',
]);
const DISPUTABLE: ReadonlySet<string> = new Set(['CHECKED_OUT', 'CUSTOMER_CONFIRMED', 'COMPLETED']);
const SAFETY_VISIBLE: ReadonlySet<string> = new Set([
  'SCHEDULED',
  'PROVIDER_ARRIVING',
  'CHECKED_IN',
  'IN_PROGRESS',
  'CHECKED_OUT',
  'SAFETY_HOLD',
]);

export function customerActions(status: string): CustomerActions {
  return {
    canPay: status === 'CONFIRMED',
    canCancel: CANCELLABLE_BY_PARTY.has(status),
    canConfirmService: status === 'CHECKED_OUT',
    canReview: status === 'COMPLETED' || status === 'SETTLED',
    canDispute: DISPUTABLE.has(status),
    hasSafetySession: SAFETY_VISIBLE.has(status),
  };
}

export const PAYMENT_STATUS_VIEW: Record<PaymentStatus, StatusView> = {
  CREATED: { label: 'Başlatıldı', tone: 'neutral' },
  AUTHORIZED: { label: 'Yetkilendirildi', tone: 'trust' },
  HELD: { label: 'Güvende tutuluyor', tone: 'trust' },
  SERVICE_COMPLETED: { label: 'Hizmet tamamlandı', tone: 'trust' },
  RELEASE_PENDING: { label: 'Aktarım bekleniyor', tone: 'neutral' },
  RELEASED: { label: 'Sağlayıcıya aktarıldı', tone: 'neutral' },
  FAILED: { label: 'Başarısız', tone: 'danger' },
  REFUNDED: { label: 'İade edildi', tone: 'neutral' },
  DISPUTED: { label: 'İtiraz nedeniyle bekletiliyor', tone: 'danger' },
  AUTHORIZATION_EXPIRED: { label: 'Yetki süresi doldu', tone: 'danger' },
};

export function paymentStatusView(status: string): StatusView {
  return PAYMENT_STATUS_VIEW[status as PaymentStatus] ?? { label: status, tone: 'neutral' };
}

export const DISPUTE_REASON_LABELS: Record<DisputeReason, string> = {
  SERVICE_NOT_PERFORMED: 'Hizmet verilmedi',
  SERVICE_QUALITY: 'Hizmet kalitesi',
  DAMAGE: 'Hasar',
  BILLING: 'Ücretlendirme',
  SAFETY: 'Güvenlik',
  OTHER: 'Diğer',
};

/** Kanıt dosyası türleri — müşteri ve sağlayıcı aynı adı görür. */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  BEFORE_PHOTO: 'Önce',
  AFTER_PHOTO: 'Sonra',
  SERVICE_NOTE: 'Hizmet notu',
  DISPUTE_EVIDENCE: 'İtiraz kanıtı',
  INVOICE: 'Fatura',
};

export const DISPUTE_STATUS_LABELS: Record<DisputeStatus, string> = {
  OPEN: 'Açık',
  UNDER_REVIEW: 'İnceleniyor',
  RESOLVED_CUSTOMER: 'Lehinize sonuçlandı',
  RESOLVED_PROVIDER: 'Sağlayıcı lehine sonuçlandı',
  WITHDRAWN: 'Geri çekildi',
};

/**
 * Para minor unit **string** olarak gelir (BIGINT); `Number`'a çevrilmez — büyük tutarda
 * hassasiyet kaybı olurdu (Faz 5 review bulgusu M2).
 */
export function formatMoney(minor: string, currency: string): string {
  if (!/^-?\d+$/.test(minor)) return `${minor} ${currency}`;
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0');
  const whole = BigInt(digits.slice(0, -2));
  const fraction = digits.slice(-2);
  const grouped = new Intl.NumberFormat('tr-TR').format(whole);
  const symbol = currency === 'TRY' ? '₺' : currency;
  return `${negative ? '-' : ''}${grouped},${fraction} ${symbol}`;
}

const DATE_TIME: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Istanbul',
};
const TIME: Intl.DateTimeFormatOptions = { timeStyle: 'short', timeZone: 'Europe/Istanbul' };

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('tr-TR', DATE_TIME);
}

/** Aynı gün içindeki aralık tek tarihle yazılır: "12 Eki 2026 10:00 – 12:00". */
export function formatRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = (date: Date) =>
    date.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'medium' });
  if (day(start) === day(end)) {
    return `${start.toLocaleString('tr-TR', DATE_TIME)} – ${end.toLocaleTimeString('tr-TR', TIME)}`;
  }
  return `${formatDateTime(startIso)} – ${formatDateTime(endIso)}`;
}

/**
 * Eşleştirme açıklaması kapalı kod kümesidir; metni istemci üretir (ADR-0007 §6).
 * Bilinmeyen kod (yeni motor sürümü) sessizce atlanır — ham kod kullanıcıya gösterilmez.
 */
export function explanationText(
  code: ExplanationCode | string,
  value: number | null,
): string | null {
  switch (code) {
    case 'ALL_REQUIRED_SKILLS_VERIFIED':
      return 'Gerekli tüm becerileri doğrulanmış';
    case 'EXPERT_LEVEL_SKILLS':
      return 'Bu işte uzman seviyesinde';
    case 'PREFERRED_SKILLS_MATCHED':
      return 'Tercih ettiğiniz becerilere sahip';
    case 'PREFERRED_SKILLS_PARTIAL':
      return 'Tercih ettiğiniz becerilerin bir kısmına sahip';
    case 'FULL_WINDOW_AVAILABLE':
      return 'İstediğiniz zaman aralığının tamamında müsait';
    case 'PARTIAL_WINDOW_AVAILABLE':
      return 'İstediğiniz aralığın bir bölümünde müsait';
    case 'NEARBY':
      return value !== null ? `Yaklaşık ${Math.round(value)} km uzaklıkta` : 'Size yakın';
    case 'WITHIN_SERVICE_AREA':
      return 'Hizmet bölgesi adresinizi kapsıyor';
    case 'HIGH_RATING':
      return value !== null
        ? `Yüksek puanlı (${value.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}/5)`
        : 'Yüksek puanlı';
    case 'LIMITED_RATING_HISTORY':
      return 'Henüz az değerlendirmesi var';
    case 'EXPERIENCED':
      return 'Deneyimli';
    default:
      return null;
  }
}

/**
 * Backend eşiği 0,6'dır (MIN_AUTO_CONFIDENCE — altı zaten talep oluşturmaz). Bu eşik yalnızca
 * **tavsiye**dir: sınırdaki ayrıştırmada kullanıcıdan bilgileri kontrol etmesi istenir.
 */
export const REVIEW_CONFIDENCE_ADVISORY = 0.8;

export function needsReview(confidence: number | null): boolean {
  return confidence !== null && confidence < REVIEW_CONFIDENCE_ADVISORY;
}
