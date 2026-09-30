import { pathSegment, type ApiClient } from '../client';
import { ApiError } from '../errors';

/** Kaynak: services/api/src/bookings/state/booking-status.ts (CLAUDE.md §4 Booking). */
export type BookingStatus =
  | 'REQUESTED'
  | 'MATCHED'
  | 'PROVIDER_PENDING'
  | 'CONFIRMED'
  | 'PAYMENT_AUTHORIZED'
  | 'SCHEDULED'
  | 'PROVIDER_ARRIVING'
  | 'CHECKED_IN'
  | 'IN_PROGRESS'
  | 'CHECKED_OUT'
  | 'CUSTOMER_CONFIRMED'
  | 'COMPLETED'
  | 'SETTLED'
  | 'CANCELLED'
  | 'DISPUTED'
  | 'SAFETY_HOLD';

/** Kaynak: services/api/src/bookings/dto/booking.dto.ts (BookingResponseDto). */
export interface Booking {
  id: string;
  customerId: string;
  providerId: string | null;
  serviceId: string;
  addressId: string;
  scheduledStart: string;
  scheduledEnd: string;
  /** Minor unit, **string** (BIGINT) — sayıya çevrilmeden biçimlendirilir. */
  priceMinor: string;
  currency: string;
  status: BookingStatus;
}

/** Kaynak: BookingHistoryResponseDto. */
export interface BookingHistoryEntry {
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  reason: string | null;
  createdAt: string;
}

/** Kaynak: BookingAddressResponseDto — rezervasyonun hizmet adresi (R-102). */
export interface BookingAddress {
  city: string;
  district: string;
  line: string;
  latitude: number;
  longitude: number;
}

/** Kaynak: TransitionBookingDto — gövdeli geçişlerin kapalı kümesi. */
export type BookingTransitionTarget =
  'PROVIDER_ARRIVING' | 'CHECKED_IN' | 'IN_PROGRESS' | 'CHECKED_OUT' | 'CUSTOMER_CONFIRMED';

/** Kaynak: services/api/src/payments/state/payment-status.ts. */
export type PaymentStatus =
  | 'CREATED'
  | 'AUTHORIZED'
  | 'HELD'
  | 'SERVICE_COMPLETED'
  | 'RELEASE_PENDING'
  | 'RELEASED'
  | 'FAILED'
  | 'REFUNDED'
  | 'DISPUTED'
  | 'AUTHORIZATION_EXPIRED';

/** Kaynak: services/api/src/payments/dto/payment.dto.ts (PaymentResponseDto). */
export interface Payment {
  id: string;
  bookingId: string;
  amountMinor: string;
  currency: string;
  refundedMinor: string;
  status: PaymentStatus;
  authorizationExpiresAt: string | null;
  releasedAt: string | null;
}

/** Kaynak: PaymentIntentResponseDto. Gövde boştur: tutar sunucuda rezervasyondan okunur. */
export interface PaymentIntent {
  paymentId: string;
  clientToken: string;
  amountMinor: string;
  currency: string;
  status: PaymentStatus;
  expiresAt: string;
}

/** Kaynak: services/api/src/reviews/dto (ReviewResponseDto). */
export interface Review {
  id: string;
  bookingId: string;
  subjectUserId: string;
  rating: number;
  comment: string | null;
  createdAt: string;
}

/** Kaynak: CreateReviewDto — rating 1..5, comment ≤2000. */
export interface CreateReviewInput {
  rating: number;
  comment?: string;
}

/** Kaynak: services/api/src/disputes/disputes.service.ts (DISPUTE_REASONS). */
export type DisputeReason =
  'SERVICE_NOT_PERFORMED' | 'SERVICE_QUALITY' | 'DAMAGE' | 'BILLING' | 'SAFETY' | 'OTHER';

export type DisputeStatus =
  'OPEN' | 'UNDER_REVIEW' | 'RESOLVED_CUSTOMER' | 'RESOLVED_PROVIDER' | 'WITHDRAWN';

/** Kaynak: services/api/src/disputes/dto (DisputeResponseDto) — açan taraf bilgisi yoktur. */
export interface Dispute {
  id: string;
  bookingId: string;
  reason: DisputeReason;
  description: string | null;
  status: DisputeStatus;
  resolution: string | null;
  refundAmountMinor: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Kaynak: OpenDisputeDto — description ≤2000. */
export interface OpenDisputeInput {
  reason: DisputeReason;
  description?: string;
}

export function bookingsApi(client: ApiClient) {
  const base = (id: string) => `/bookings/${pathSegment(id)}`;
  return {
    list: () => client.get<Booking[]>('/bookings'),
    get: (id: string) => client.get<Booking>(base(id)),
    history: (id: string) => client.get<BookingHistoryEntry[]>(`${base(id)}/history`),
    /**
     * Hizmet adresi. Sağlayıcıya yalnız `SCHEDULED`…`CHECKED_OUT` arasında açıktır
     * (`BOOKING_ADDRESS_UNAVAILABLE`, 409) ve her okuması audit'lidir.
     */
    address: (id: string) => client.get<BookingAddress>(`${base(id)}/address`),
    cancel: (id: string, reason: string | undefined, idempotencyKey: string) =>
      client.post<Booking>(`${base(id)}/cancel`, reason ? { reason } : {}, { idempotencyKey }),
    /** Sağlayıcı onayı: `PROVIDER_PENDING → CONFIRMED`. Ret, `cancel` ile yapılır. */
    confirm: (id: string, idempotencyKey: string) =>
      client.post<Booking>(`${base(id)}/confirm`, {}, { idempotencyKey }),
    transition: (id: string, to: BookingTransitionTarget, idempotencyKey: string) =>
      client.post<Booking>(`${base(id)}/transitions`, { to }, { idempotencyKey }),

    /** Ödeme henüz başlatılmadıysa backend `404 NOT_FOUND` döner → `null`. */
    payment: async (id: string): Promise<Payment | null> => {
      try {
        return await client.get<Payment>(`${base(id)}/payment`);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    authorizePayment: (id: string, idempotencyKey: string) =>
      client.post<PaymentIntent>(`${base(id)}/payment`, {}, { idempotencyKey }),

    createReview: (id: string, body: CreateReviewInput, idempotencyKey: string) =>
      client.post<Review>(`${base(id)}/review`, body, { idempotencyKey }),
    reviewsFor: (userId: string) => client.get<Review[]>(`/users/${pathSegment(userId)}/reviews`),

    disputes: (id: string) => client.get<Dispute[]>(`${base(id)}/disputes`),
    openDispute: (id: string, body: OpenDisputeInput, idempotencyKey: string) =>
      client.post<Dispute>(`${base(id)}/disputes`, body, { idempotencyKey }),
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'NOT_FOUND';
}
