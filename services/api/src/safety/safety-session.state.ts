import type { BookingStatus } from '../bookings/state/booking-status';
import type { SafetyClosureReason, SafetySessionStatus } from './safety.constants';

/**
 * Oturum durum geçişleri — tek doğruluk kaynağı.
 *
 * Booking state machine ile **aynı disiplin** (ADR-0006): geçiş kuralları
 * controller/service içine dağıtılmaz, tabloda durur. Ama bilinçli bir fark var:
 * bu makine **ikinci bir iş yaşam döngüsü değildir**. Rezervasyonun kendi durumu
 * otoritedir; oturum onu **izler** (ADR-0019 §2). Oturum kendi başına yalnızca
 * iki yoldan ilerler: operatör kapatması ve süre aşımı.
 *
 * Veritabanı iki invariant'ı ayrıca garanti eder (trigger): durum geri gitmez ve
 * `CLOSED` terminaldir. Tablonun tamamı burada, kopyası orada değil.
 */
export interface SafetyTransition {
  from: SafetySessionStatus;
  to: SafetySessionStatus;
}

export const SAFETY_TRANSITIONS: readonly SafetyTransition[] = [
  // Ödeme yetkilendirildi ve randevu planlandı: oturum açılır ama **telemetri
  // başlamaz**. Rezervasyon var diye konum toplamak, tam olarak kaçınılan şeydir.
  { from: 'NOT_STARTED', to: 'PRE_SERVICE' },

  // Sağlayıcı yola çıktı: varış izleme başlar, telemetri **burada** açılır.
  { from: 'PRE_SERVICE', to: 'ARRIVAL_MONITORING' },

  // Check-in: hizmet başlıyor.
  { from: 'ARRIVAL_MONITORING', to: 'ACTIVE' },

  // Kapanış her aşamadan mümkündür (check-out, iptal, operatör, süre aşımı).
  { from: 'PRE_SERVICE', to: 'CLOSED' },
  { from: 'ARRIVAL_MONITORING', to: 'CLOSED' },
  { from: 'ACTIVE', to: 'CLOSED' },
];

const INDEX = new Set(SAFETY_TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`));

export function isAllowedSafetyTransition(
  from: SafetySessionStatus,
  to: SafetySessionStatus,
): boolean {
  return INDEX.has(`${from}->${to}`);
}

/**
 * Bir hedefe ulaşmak için izlenecek ileri yol (hedef dahil).
 *
 * Oturumu olmayan bir rezervasyon (Faz 8 öncesinde planlanmış ya da oturum
 * açılırken hata almış) `PROVIDER_ARRIVING`'e geldiğinde oturum `PRE_SERVICE`
 * olarak açılır ve buradan **tabloda tanımlı** adımlarla ilerletilir. Adım atlamak
 * yerine yolu yürümek, her ara geçişin olay kaydı üretmesini sağlar.
 */
export function forwardPath(
  from: SafetySessionStatus,
  to: SafetySessionStatus,
): SafetySessionStatus[] | null {
  if (from === to) {
    return [];
  }
  if (to === 'CLOSED') {
    return isAllowedSafetyTransition(from, 'CLOSED') ? ['CLOSED'] : null;
  }

  const ladder: SafetySessionStatus[] = [
    'NOT_STARTED',
    'PRE_SERVICE',
    'ARRIVAL_MONITORING',
    'ACTIVE',
  ];
  const start = ladder.indexOf(from);
  const end = ladder.indexOf(to);
  if (start < 0 || end < 0 || end < start) {
    return null;
  }
  return ladder.slice(start + 1, end + 1);
}

export interface BookingSafetyEffect {
  target: SafetySessionStatus;
  closureReason?: SafetyClosureReason;
}

/**
 * Booking durumunun oturumdaki karşılığı.
 *
 * `null` dönen durumlar oturuma dokunmaz. Bu eşleme, "hangi booking durumu
 * telemetriyi açar/kapatır" sorusunun **tek** cevabıdır; başka hiçbir yerde
 * tekrar edilmez.
 *
 * Bilinçli seçimler:
 * - `PROVIDER_PENDING`/`CONFIRMED` oturum **açmaz**: ödeme yetkilendirilmemiş ve
 *   randevu kesinleşmemiş bir işte güvenlik oturumunun amacı yoktur.
 * - `CHECKED_OUT` oturumu kapatır. Rezervasyon (onay, ödeme, değerlendirme) devam
 *   eder ama konum toplamanın amacı bitmiştir — veri minimizasyonu.
 * - `SAFETY_HOLD` oturuma dokunmaz: askı sırasında izleme **sürer**; kapatmak,
 *   tam da en çok ihtiyaç duyulan anda telemetriyi kesmek olurdu.
 * - `IN_PROGRESS` → `ACTIVE`: normal akışta oturum `CHECKED_IN` ile zaten aktiftir
 *   (tekrar çağrı etkisizdir). Varış sırasında konan bir askı operatör kararıyla
 *   `IN_PROGRESS`'e dönerse oturum da hizmet izlemeye geçer.
 */
export function safetyEffectForBooking(status: BookingStatus): BookingSafetyEffect | null {
  switch (status) {
    case 'SCHEDULED':
      return { target: 'PRE_SERVICE' };
    case 'PROVIDER_ARRIVING':
      return { target: 'ARRIVAL_MONITORING' };
    case 'CHECKED_IN':
    case 'IN_PROGRESS':
      return { target: 'ACTIVE' };
    case 'CHECKED_OUT':
    case 'CUSTOMER_CONFIRMED':
    case 'COMPLETED':
    case 'SETTLED':
      return { target: 'CLOSED', closureReason: 'SERVICE_COMPLETED' };
    case 'CANCELLED':
      return { target: 'CLOSED', closureReason: 'BOOKING_CANCELLED' };
    case 'DISPUTED':
      // Normal akışta oturum check-out ile zaten kapanmıştır. Açık kalmışsa
      // (askıdan uyuşmazlığa operatör kararıyla geçiş) kapanış operatöründür.
      return { target: 'CLOSED', closureReason: 'OPERATOR_CLOSED' };
    default:
      return null;
  }
}

/** Oturumu **açabilen** hedefler: kapanış hedefi yeni oturum açmaz. */
export function opensSession(effect: BookingSafetyEffect): boolean {
  return effect.target !== 'CLOSED';
}
