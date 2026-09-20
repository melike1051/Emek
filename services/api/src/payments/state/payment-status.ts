/** Veritabanındaki `payment_status` enum'u ile birebir aynı (ADR-0009 §3). */
export const PAYMENT_STATUSES = [
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
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Ödemenin ilerleme sırası.
 *
 * Out-of-order webhook teslimi kaçınılmazdır (T-10): sağlayıcı `CAPTURED`'ı
 * `AUTHORIZED`'dan önce teslim edebilir. Sıra numarası olmayan bir sağlayıcıda geri
 * geçişi tespit etmenin tek yolu bu sıralamadır — `RELEASED` bir ödeme, gecikmiş bir
 * `AUTHORIZED` olayıyla geriye çekilmemelidir.
 *
 * Yan durumların sırası yoktur (`null`): oraya geçiş sıraya değil kurala bağlıdır.
 */
const PROGRESS_ORDER: Partial<Record<PaymentStatus, number>> = {
  CREATED: 0,
  AUTHORIZED: 1,
  HELD: 2,
  SERVICE_COMPLETED: 3,
  RELEASE_PENDING: 4,
  RELEASED: 5,
};

export function progressRank(status: PaymentStatus): number | null {
  return PROGRESS_ORDER[status] ?? null;
}

/** İlerlemenin bittiği durumlar: buradan çıkış yoktur. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'RELEASED',
  'FAILED',
  'REFUNDED',
  'AUTHORIZATION_EXPIRED',
];

export function isTerminalPayment(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}

/**
 * Yetkilendirmenin canlı olduğu durumlar — release yalnızca bu durumlardan mümkündür.
 */
export const AUTHORIZED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'AUTHORIZED',
  'HELD',
  'SERVICE_COMPLETED',
  'RELEASE_PENDING',
];

export function holdsAuthorization(status: PaymentStatus): boolean {
  return AUTHORIZED_PAYMENT_STATUSES.includes(status);
}
