import { type PaymentStatus, progressRank } from './payment-status';

/**
 * Ödeme durum geçişleri (ADR-0009 §3).
 *
 * Booking'in transition map'iyle aynı disiplin: kurallar tek tablodadır, servise
 * dağıtılmaz. Ödeme durumu booking'in **projeksiyonudur** — çelişkide booking
 * guard'ları belirleyicidir (ADR-0009 §3) — ama projeksiyonun kendi içinde tutarsız
 * olmasına da izin verilmez.
 */
export interface PaymentTransitionRule {
  from: PaymentStatus;
  to: PaymentStatus;
  /**
   * Geçişi tetikleyen kaynak:
   * - `COMMAND`: Emek'in senkron çağrısının sonucu (authorize/capture/refund).
   * - `WEBHOOK`: sağlayıcının bildirdiği olay.
   * - `SYSTEM`: zamana bağlı iç karar (süre dolması).
   */
  sources: readonly ('COMMAND' | 'WEBHOOK' | 'SYSTEM')[];
}

export const PAYMENT_TRANSITIONS: readonly PaymentTransitionRule[] = [
  // --- Mutlu yol ---
  { from: 'CREATED', to: 'AUTHORIZED', sources: ['COMMAND', 'WEBHOOK'] },
  // Hold, yetkilendirmenin hizmet gününe kadar tutulduğu durumdur.
  { from: 'AUTHORIZED', to: 'HELD', sources: ['COMMAND', 'WEBHOOK'] },
  { from: 'HELD', to: 'SERVICE_COMPLETED', sources: ['SYSTEM'] },
  { from: 'SERVICE_COMPLETED', to: 'RELEASE_PENDING', sources: ['COMMAND'] },
  { from: 'RELEASE_PENDING', to: 'RELEASED', sources: ['COMMAND', 'WEBHOOK'] },

  // --- Başarısızlık ---
  // Yetkilendirme reddi yalnızca yetkilendirme öncesinde anlamlıdır: HELD bir ödeme
  // "başarısız" olamaz, iade edilir.
  { from: 'CREATED', to: 'FAILED', sources: ['COMMAND', 'WEBHOOK'] },

  // --- Süre dolması (ADR-0009 §4) ---
  // Süre dolması bir gerçektir, karar değil: hem zamanlanmış iş hem sağlayıcı bildirimi
  // aynı sonuca götürür.
  ...(['AUTHORIZED', 'HELD', 'SERVICE_COMPLETED'] as const).map((from) => ({
    from,
    to: 'AUTHORIZATION_EXPIRED' as PaymentStatus,
    sources: ['SYSTEM', 'WEBHOOK'] as const,
  })),

  // --- İade ---
  // Yetkilendirilmiş (henüz tahsil edilmemiş) tutar da iade/void ile kapanır; ayrı bir
  // VOID durumu tutmak yerine iade olarak izlenir (ADR-0017 §3).
  ...(['AUTHORIZED', 'HELD', 'SERVICE_COMPLETED', 'RELEASE_PENDING', 'RELEASED'] as const).map(
    (from) => ({
      from,
      to: 'REFUNDED' as PaymentStatus,
      sources: ['COMMAND', 'WEBHOOK'] as const,
    }),
  ),

  // --- Uyuşmazlık ---
  // Uyuşmazlık ödemeyi dondurur. Çıkış yalnızca operatör kararının sonucudur:
  // otomatik olarak release'e dönmek, uyuşmazlığı sessizce müşteri aleyhine kapatmak olurdu.
  ...(['AUTHORIZED', 'HELD', 'SERVICE_COMPLETED', 'RELEASE_PENDING', 'RELEASED'] as const).map(
    (from) => ({
      from,
      to: 'DISPUTED' as PaymentStatus,
      sources: ['SYSTEM', 'WEBHOOK'] as const,
    }),
  ),
  { from: 'DISPUTED', to: 'REFUNDED', sources: ['COMMAND'] },
  // Uyuşmazlık/askı çözüldüğünde ödeme **dondurulduğu duruma** geri döner
  // (`payments.frozen_from_status`). Tek bir geri dönüş durumu seçmek, diğer senaryoda
  // parayı kalıcı olarak kilitlerdi (Faz 5 review bulgusu C2): sağlayıcı lehine karar
  // verilmiş bir uyuşmazlıkta para ne serbest bırakılabilir ne iade edilebilirdi.
  ...(['AUTHORIZED', 'HELD', 'SERVICE_COMPLETED', 'RELEASE_PENDING'] as const).map((to) => ({
    from: 'DISPUTED' as PaymentStatus,
    to: to as PaymentStatus,
    sources: ['COMMAND'] as const,
  })),
];

const INDEX = new Map<string, PaymentTransitionRule>(
  PAYMENT_TRANSITIONS.map((rule) => [`${rule.from}->${rule.to}`, rule]),
);

export function findPaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): PaymentTransitionRule | undefined {
  return INDEX.get(`${from}->${to}`);
}

export function isSourceAllowed(
  rule: PaymentTransitionRule,
  source: 'COMMAND' | 'WEBHOOK' | 'SYSTEM',
): boolean {
  return rule.sources.includes(source);
}

/**
 * Geçiş ilerleme sırasına göre geriye mi gidiyor?
 *
 * Gecikmiş bir webhook (`RELEASED` ödemeye gelen `AUTHORIZED`) bu kontrolle reddedilir.
 * Transition map bunu tek başına yakalamaz: yan durumlara geçişler sırasızdır, bu yüzden
 * sıralı durumlar arasında ayrıca karşılaştırma gerekir (T-10).
 */
export function isBackwardProgress(from: PaymentStatus, to: PaymentStatus): boolean {
  const fromRank = progressRank(from);
  const toRank = progressRank(to);

  if (fromRank === null || toRank === null) {
    return false;
  }
  return toRank < fromRank;
}
