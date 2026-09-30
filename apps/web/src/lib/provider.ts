import type {
  AvailabilityWindow,
  BookingStatus,
  BookingTransitionTarget,
  DocumentType,
  ProviderService,
  ServiceArea,
} from '@emek/api-client';
import type { BadgeTone } from '@emek/ui';

/**
 * Sağlayıcı diliyle durum etiketleri — müşteri etiketleri (`BOOKING_STATUS_VIEW`) karşı tarafın
 * bakışıdır ("Sağlayıcı onayı bekleniyor"), sağlayıcıya yanlış şeyi söylerdi.
 */
export const PROVIDER_BOOKING_STATUS_VIEW: Record<
  BookingStatus,
  { label: string; tone: BadgeTone }
> = {
  REQUESTED: { label: 'Talep alındı', tone: 'neutral' },
  MATCHED: { label: 'Eşleşti', tone: 'neutral' },
  PROVIDER_PENDING: { label: 'Yanıtınız bekleniyor', tone: 'highlight' },
  CONFIRMED: { label: 'Müşteri ödemesi bekleniyor', tone: 'neutral' },
  PAYMENT_AUTHORIZED: { label: 'Ödeme güvende', tone: 'trust' },
  SCHEDULED: { label: 'Planlandı', tone: 'trust' },
  PROVIDER_ARRIVING: { label: 'Yoldasınız', tone: 'trust' },
  CHECKED_IN: { label: 'Adrestesiniz', tone: 'trust' },
  IN_PROGRESS: { label: 'Hizmet sürüyor', tone: 'trust' },
  CHECKED_OUT: { label: 'Müşteri onayı bekleniyor', tone: 'highlight' },
  CUSTOMER_CONFIRMED: { label: 'Müşteri onayladı', tone: 'trust' },
  COMPLETED: { label: 'Tamamlandı', tone: 'trust' },
  SETTLED: { label: 'Ödeme aktarıldı', tone: 'neutral' },
  CANCELLED: { label: 'İptal edildi', tone: 'neutral' },
  DISPUTED: { label: 'İtiraz inceleniyor', tone: 'danger' },
  SAFETY_HOLD: { label: 'Güvenlik incelemesi', tone: 'danger' },
};

export function providerBookingStatusView(status: string): { label: string; tone: BadgeTone } {
  return (
    PROVIDER_BOOKING_STATUS_VIEW[status as BookingStatus] ?? { label: status, tone: 'neutral' }
  );
}

/** Hizmet günü akışında sağlayıcının bir sonraki adımı (transition map'teki PROVIDER geçişleri). */
export interface NextStep {
  to: BookingTransitionTarget;
  label: string;
  confirmLabel: string;
  hint: string;
}

const NEXT_STEP: Partial<Record<string, NextStep>> = {
  SCHEDULED: {
    to: 'PROVIDER_ARRIVING',
    label: 'Yola çıktım',
    confirmLabel: 'Evet, yola çıkıyorum',
    hint: 'Yola çıktığınızda güvenlik oturumu başlar; müşteri sizin yolda olduğunuzu görür.',
  },
  PROVIDER_ARRIVING: {
    to: 'CHECKED_IN',
    label: 'Adrese vardım',
    confirmLabel: 'Evet, adresteyim',
    hint: 'Vardığınızda başlamadan önce “önce” fotoğrafını ekleyin.',
  },
  CHECKED_IN: {
    to: 'IN_PROGRESS',
    label: 'Hizmeti başlat',
    confirmLabel: 'Evet, başlıyorum',
    hint: 'Başlamadan önce “önce” fotoğrafı eklemeniz, olası bir itirazda sizi korur.',
  },
  IN_PROGRESS: {
    to: 'CHECKED_OUT',
    label: 'Hizmeti bitirdim',
    confirmLabel: 'Evet, hizmet bitti',
    hint: 'Bitirmeden önce “sonra” fotoğrafını ekleyin. Ardından müşterinin onayı beklenir.',
  },
};

/**
 * Sağlayıcının bu durumda yapabilecekleri — backend transition map'inin (ADR-0006) **aynası**dır,
 * yetki kaynağı değildir: backend her komutu ayrıca doğrular, reddi ekranda gösterilir.
 */
export interface ProviderActions {
  canRespond: boolean;
  canCancel: boolean;
  next: NextStep | null;
  /** Bu durumda eklenebilecek kanıt türleri (backend türü duruma bağlamaz; akış bağlar). */
  uploadable: DocumentType[];
  hasSafetySession: boolean;
  /**
   * Hizmet adresi görünürlüğü (R-102): backend'in `PROVIDER_ADDRESS_STATUSES` penceresinin
   * aynası. `AFTER_PAYMENT`: henüz açılmadı; `CLOSED`: hizmet bitti veya randevu kapandı.
   */
  address: 'VISIBLE' | 'AFTER_PAYMENT' | 'CLOSED';
}

const ADDRESS_VISIBLE: ReadonlySet<string> = new Set([
  'SCHEDULED',
  'PROVIDER_ARRIVING',
  'CHECKED_IN',
  'IN_PROGRESS',
  'CHECKED_OUT',
]);
const ADDRESS_PENDING: ReadonlySet<string> = new Set([
  'REQUESTED',
  'MATCHED',
  'PROVIDER_PENDING',
  'CONFIRMED',
  'PAYMENT_AUTHORIZED',
]);

const CANCELLABLE_BY_PARTY: ReadonlySet<string> = new Set([
  'CONFIRMED',
  'PAYMENT_AUTHORIZED',
  'SCHEDULED',
  'PROVIDER_ARRIVING',
]);
const SAFETY_VISIBLE: ReadonlySet<string> = new Set([
  'SCHEDULED',
  'PROVIDER_ARRIVING',
  'CHECKED_IN',
  'IN_PROGRESS',
  'CHECKED_OUT',
  'SAFETY_HOLD',
]);

export function providerActions(status: string): ProviderActions {
  const uploadable: DocumentType[] = [];
  if (status === 'CHECKED_IN' || status === 'IN_PROGRESS') uploadable.push('BEFORE_PHOTO');
  if (status === 'IN_PROGRESS' || status === 'CHECKED_OUT') uploadable.push('AFTER_PHOTO');
  return {
    // Ret = `PROVIDER_PENDING → CANCELLED` (ayrı "reddet" ucu yoktur).
    canRespond: status === 'PROVIDER_PENDING',
    canCancel: CANCELLABLE_BY_PARTY.has(status),
    next: NEXT_STEP[status] ?? null,
    uploadable,
    hasSafetySession: SAFETY_VISIBLE.has(status),
    address: ADDRESS_VISIBLE.has(status)
      ? 'VISIBLE'
      : ADDRESS_PENDING.has(status)
        ? 'AFTER_PAYMENT'
        : 'CLOSED',
  };
}

// --- Zaman: hizmet saatleri İstanbul saatiyle girilir ve gösterilir ---

/**
 * Türkiye 2016'dan beri sabit UTC+3'tür (yaz saati yok). Tarayıcının kendi saat dilimine
 * güvenilmez: yurt dışındaki bir cihaz "09:00"u başka bir ana çevirirdi.
 */
const ISTANBUL_OFFSET = '+03:00';

/** `2026-10-12` + `09:30` (İstanbul) → ISO 8601 UTC. Geçersiz girdi → `null`. */
export function istanbulToIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const parsed = new Date(`${date}T${time}:00${ISTANBUL_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** ISO → İstanbul takvim günü (`YYYY-MM-DD`). */
export function istanbulDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
}

/** İstanbul takvim gününe gün ekler (`YYYY-MM-DD`). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00${ISTANBUL_OFFSET}`);
  date.setUTCDate(date.getUTCDate() + days);
  return istanbulDay(date.toISOString());
}

/** Haftanın pazartesisi (İstanbul) — müsaitlik haftalık görüntülenir. */
export function weekStart(day: string): string {
  const weekday = new Date(`${day}T12:00:00${ISTANBUL_OFFSET}`).getUTCDay(); // 0 = pazar
  return addDays(day, weekday === 0 ? -6 : 1 - weekday);
}

/** Haftanın 7 günü ve pencerelerin güne göre gruplanması (başlangıç gününe göre). */
export function groupByDay(
  windows: AvailabilityWindow[],
  monday: string,
): { day: string; windows: AvailabilityWindow[] }[] {
  const days = Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  return days.map((day) => ({
    day,
    windows: windows
      .filter((window) => istanbulDay(window.startsAt) === day)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
  }));
}

// --- Başvuru hazırlığı ---

export interface ReadinessItem {
  key: 'profile' | 'services' | 'areas' | 'availability' | 'identity';
  label: string;
  done: boolean;
  href: string | null;
}

/**
 * Eşleştirmeye girmek için gerekenler (Faz 7 aday havuzu + hard constraint'ler). Backend başvuruyu
 * bunlara bağlamaz — liste yol göstericidir; eksik profil operatör incelemesinde döner.
 */
export function readiness(input: {
  bio: string | null;
  services: ProviderService[];
  areas: ServiceArea[];
  upcomingAvailability: number;
  identityVerified: boolean;
}): ReadinessItem[] {
  return [
    {
      key: 'profile',
      label: 'Kendinizi tanıtın',
      done: (input.bio ?? '').trim().length > 0,
      href: '/panel/profil',
    },
    {
      key: 'services',
      label: 'Sunduğunuz hizmetleri seçin',
      done: input.services.some((service) => service.active),
      href: '/panel/hizmetler',
    },
    {
      key: 'areas',
      label: 'Hizmet bölgenizi ekleyin',
      done: input.areas.some((area) => area.active),
      href: '/panel/bolgeler',
    },
    {
      key: 'availability',
      label: 'Müsait olduğunuz saatleri girin',
      done: input.upcomingAvailability > 0,
      href: '/panel/musaitlik',
    },
    {
      key: 'identity',
      label: 'Kimliğinizi doğrulayın',
      done: input.identityVerified,
      // TODO(faz-15): `/kimlik` ekranı (plan §2.1) henüz yok; doğrulama durumu salt okunur.
      href: null,
    },
  ];
}

export const RADIUS_OPTIONS_KM = [1, 3, 5, 10, 20, 50] as const;

export function formatRadius(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} km`
    : `${meters} m`;
}
