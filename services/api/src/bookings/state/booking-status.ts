/** Veritabanındaki `booking_status` enum'u ile birebir aynı (ADR-0006). */
export const BOOKING_STATUSES = [
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
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Rezervasyonun artık ilerlemediği durumlar. */
export const TERMINAL_STATUSES: readonly BookingStatus[] = ['SETTLED', 'CANCELLED'];

/**
 * Ödemenin serbest bırakılmasını **bloklayan** durumlar (ADR-0006 §6, ADR-0009 §9).
 * Kural state machine'de tanımlıdır; ödeme modülünün insafına bırakılmaz.
 */
export const PAYMENT_BLOCKING_STATUSES: readonly BookingStatus[] = ['SAFETY_HOLD', 'DISPUTED'];

export function isTerminal(status: BookingStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function blocksPaymentRelease(status: BookingStatus): boolean {
  return PAYMENT_BLOCKING_STATUSES.includes(status);
}
