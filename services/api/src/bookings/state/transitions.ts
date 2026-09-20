import type { AppRole } from '../../users/user.types';
import type { BookingStatus } from './booking-status';

/**
 * Tek doğruluk kaynağı: izin verilen booking durum geçişleri (ADR-0006 §2).
 *
 * Geçiş kuralları controller/service kodu içine dağıtılmaz. Dağıtılsaydı geçersiz bir
 * geçiş yalnızca kod incelemesiyle yakalanabilirdi; burada tablo hâlinde olduğu için
 * hem tipe hem teste bağlanır.
 *
 * `actors`: geçişi tetiklemeye yetkili taraflar. `CUSTOMER`/`PROVIDER` **ilgili**
 * rezervasyonun tarafı olmak zorundadır (sahiplik kontrolü ayrıca yapılır — rol tek
 * başına yetki değildir, ADR-0013 §1). `SYSTEM` otomatik akışları (ödeme webhook'u,
 * safety motoru) temsil eder.
 */
export type TransitionActor = AppRole | 'SYSTEM';

export interface TransitionRule {
  from: BookingStatus;
  to: BookingStatus;
  actors: readonly TransitionActor[];
  /** Geçişin hangi fazda devreye girdiği — henüz uygulanmayan akışlar görünür kalsın. */
  phase: number;
}

export const TRANSITIONS: readonly TransitionRule[] = [
  // --- Eşleştirme (Faz 7'de matching motoru bağlanır) ---
  { from: 'REQUESTED', to: 'MATCHED', actors: ['SYSTEM'], phase: 4 },
  { from: 'MATCHED', to: 'PROVIDER_PENDING', actors: ['SYSTEM'], phase: 4 },
  { from: 'PROVIDER_PENDING', to: 'CONFIRMED', actors: ['PROVIDER'], phase: 4 },

  // --- Ödeme (Faz 5) ---
  { from: 'CONFIRMED', to: 'PAYMENT_AUTHORIZED', actors: ['SYSTEM'], phase: 5 },
  { from: 'PAYMENT_AUTHORIZED', to: 'SCHEDULED', actors: ['SYSTEM'], phase: 5 },

  // --- Hizmet günü (safety telemetrisi Faz 8'de bağlanır) ---
  { from: 'SCHEDULED', to: 'PROVIDER_ARRIVING', actors: ['PROVIDER'], phase: 4 },
  { from: 'PROVIDER_ARRIVING', to: 'CHECKED_IN', actors: ['PROVIDER'], phase: 4 },
  { from: 'CHECKED_IN', to: 'IN_PROGRESS', actors: ['PROVIDER'], phase: 4 },
  { from: 'IN_PROGRESS', to: 'CHECKED_OUT', actors: ['PROVIDER'], phase: 4 },
  { from: 'CHECKED_OUT', to: 'CUSTOMER_CONFIRMED', actors: ['CUSTOMER'], phase: 4 },
  { from: 'CUSTOMER_CONFIRMED', to: 'COMPLETED', actors: ['SYSTEM'], phase: 4 },
  { from: 'COMPLETED', to: 'SETTLED', actors: ['SYSTEM'], phase: 5 },

  // --- İptal ---
  // Hizmet başladıktan sonra iptal yoktur: o noktadan sonra yol dispute'tur.
  ...(
    [
      'REQUESTED',
      'MATCHED',
      'PROVIDER_PENDING',
      'CONFIRMED',
      'PAYMENT_AUTHORIZED',
      'SCHEDULED',
      'PROVIDER_ARRIVING',
    ] as const
  ).map((from) => ({
    from,
    to: 'CANCELLED' as BookingStatus,
    actors: ['CUSTOMER', 'PROVIDER', 'ADMIN'] as const,
    phase: 4,
  })),

  // Hizmet başladıktan sonra taraflar iptal edemez (para ve emek harcanmıştır); ancak
  // güvenlik dışı bir aksaklıkta (ekipman arızası, müşteri evde değil) rezervasyonun
  // sıkışmaması gerekir. Bu durumlarda iptal **operatör kararıdır** ve para akışı
  // dispute/refund üzerinden çözülür (Faz 5).
  ...(['CHECKED_IN', 'IN_PROGRESS', 'CHECKED_OUT'] as const).map((from) => ({
    from,
    to: 'CANCELLED' as BookingStatus,
    actors: ['ADMIN'] as const,
    phase: 4,
  })),

  // --- Güvenlik askısı (Faz 8) ---
  // Aktif hizmet akışının her noktasından askıya alınabilir: panic flow beklemez.
  ...(['SCHEDULED', 'PROVIDER_ARRIVING', 'CHECKED_IN', 'IN_PROGRESS', 'CHECKED_OUT'] as const).map(
    (from) => ({
      from,
      to: 'SAFETY_HOLD' as BookingStatus,
      actors: ['SYSTEM', 'ADMIN'] as const,
      phase: 8,
    }),
  ),
  // Askıdan çıkış yalnızca operatör kararıyla: otomatik geri dönüş, güvenlik olayını
  // sessizce kapatmak olurdu.
  { from: 'SAFETY_HOLD', to: 'IN_PROGRESS', actors: ['ADMIN'], phase: 8 },
  { from: 'SAFETY_HOLD', to: 'CANCELLED', actors: ['ADMIN'], phase: 8 },
  { from: 'SAFETY_HOLD', to: 'DISPUTED', actors: ['ADMIN'], phase: 8 },

  // --- Uyuşmazlık (Faz 5) ---
  ...(['CHECKED_OUT', 'CUSTOMER_CONFIRMED', 'COMPLETED'] as const).map((from) => ({
    from,
    to: 'DISPUTED' as BookingStatus,
    actors: ['CUSTOMER', 'PROVIDER', 'ADMIN'] as const,
    phase: 5,
  })),
  { from: 'DISPUTED', to: 'COMPLETED', actors: ['ADMIN'], phase: 5 },
  { from: 'DISPUTED', to: 'CANCELLED', actors: ['ADMIN'], phase: 5 },
];

const TRANSITION_INDEX = new Map<string, TransitionRule>(
  TRANSITIONS.map((rule) => [`${rule.from}->${rule.to}`, rule]),
);

export function findTransition(from: BookingStatus, to: BookingStatus): TransitionRule | undefined {
  return TRANSITION_INDEX.get(`${from}->${to}`);
}

export function allowedTargets(from: BookingStatus): BookingStatus[] {
  return TRANSITIONS.filter((rule) => rule.from === from).map((rule) => rule.to);
}

export function isActorAllowed(rule: TransitionRule, actor: TransitionActor): boolean {
  // SUPPORT rolü hiçbir geçişte yer almaz: okuma + not ekleme yetkisi vardır,
  // yıkıcı/ilerletici aksiyon yapamaz (ADR-0013 §4).
  return rule.actors.includes(actor);
}
