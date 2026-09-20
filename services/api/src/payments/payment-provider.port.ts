/**
 * Ödeme sağlayıcı portu (ADR-0009 §8).
 *
 * Core backend somut bir ödeme kuruluşunu tanımaz. Lisanslı sağlayıcı bu portun
 * arkasına takılır; sağlayıcı değiştiğinde domain değişmez.
 *
 * **Kart verisi bu portun içinden bile geçmez:** ödeme sayfası/SDK sağlayıcıya aittir,
 * Emek yalnızca intent referansı ve durum alır. PAN/CVV taşıyan bir alan bu dosyada
 * bilinçli olarak yoktur (PCI kapsamı dışında kalmak bir tasarım hedefidir).
 *
 * Giden her çağrı Emek tarafından üretilen bir `idempotencyKey` taşır: `external_event_id`
 * UNIQUE yalnızca **gelen** webhook'ları tekilleştirir, çift `authorize` göndermeyi
 * engellemez (ADR-0009 §5).
 */

export type PaymentOperation =
  'CREATE_INTENT' | 'AUTHORIZE' | 'REAUTHORIZE' | 'CAPTURE' | 'REFUND' | 'VOID';

export interface CreateIntentInput {
  /** Emek tarafındaki ödeme kimliği; sağlayıcıda referans olarak taşınır. */
  paymentId: string;
  bookingId: string;
  amountMinor: string;
  currency: string;
  idempotencyKey: string;
}

export interface PaymentIntent {
  externalPaymentId: string;
  /** İstemcinin sağlayıcı ödeme akışını başlatmak için kullandığı kısa ömürlü token. */
  clientToken: string;
  expiresAt: Date;
}

export interface AuthorizationResult {
  externalPaymentId: string;
  authorizedAt: Date;
  /** ADR-0009 §4: yetkilendirme süresi doludur; release bu tarihten sonra denenmez. */
  expiresAt: Date;
  resultCode: string;
}

export interface CaptureResult {
  externalPaymentId: string;
  capturedAt: Date;
  resultCode: string;
}

export interface RefundResult {
  externalPaymentId: string;
  refundedMinor: string;
  refundedAt: Date;
  resultCode: string;
}

/** Sağlayıcıdan gelen, doğrulanmış webhook. Ham gövde domain'e ulaşmaz. */
export interface PaymentWebhookEvent {
  externalEventId: string;
  externalPaymentId: string;
  /** `AUTHORIZED`, `CAPTURED`, `REFUNDED`, `FAILED`, `EXPIRED`, `DISPUTE_OPENED` … */
  type: string;
  /** Sağlayıcının olay sırası; out-of-order teslimi tespit etmek için (T-10). */
  sequence?: number;
  occurredAt?: Date;
  amountMinor?: string;
  resultCode?: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** Sağlayıcı şartlı ödeme (hold → release) destekliyor mu? Desteklemiyorsa model değişir (R-02). */
  supportsConditionalPayout(): boolean;
  createIntent(input: CreateIntentInput): Promise<PaymentIntent>;
  authorize(input: {
    externalPaymentId: string;
    idempotencyKey: string;
  }): Promise<AuthorizationResult>;
  /** Süresi yaklaşan yetkilendirmeyi yeniler (ADR-0009 §4). */
  reauthorize(input: {
    externalPaymentId: string;
    idempotencyKey: string;
  }): Promise<AuthorizationResult>;
  capture(input: {
    externalPaymentId: string;
    amountMinor: string;
    idempotencyKey: string;
  }): Promise<CaptureResult>;
  refund(input: {
    externalPaymentId: string;
    amountMinor: string;
    idempotencyKey: string;
  }): Promise<RefundResult>;
  /** İmza doğrulaması adapter'ın içindedir: imzasız/yanlış imzalı çağrı reddedilir. */
  verifyWebhook(rawBody: string, signature: string | undefined): PaymentWebhookEvent;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** Sağlayıcı kaynaklı hata; ham sağlayıcı metni istemciye taşınmaz. */
export class PaymentProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

/**
 * Sağlayıcıya ulaşılamadı.
 *
 * Kritik ayrım: çağrının sağlayıcıya **ulaşıp ulaşmadığı bilinmiyor** olabilir. Bu yüzden
 * körlemesine yeniden denenmez; aynı idempotency key ile tekrar denenir ve sağlayıcı
 * mükerrer çağrıyı kendi tarafında eler.
 */
export class PaymentProviderUnavailableError extends PaymentProviderError {
  constructor(message = 'payment provider unavailable') {
    super('PROVIDER_UNAVAILABLE', message);
    this.name = 'PaymentProviderUnavailableError';
  }
}

/** Sağlayıcı çağrıyı reddetti (yetersiz bakiye, kart reddi vb.). */
export class PaymentDeclinedError extends PaymentProviderError {
  constructor(
    readonly declineCode: string,
    message = 'payment declined',
  ) {
    super('DECLINED', message);
    this.name = 'PaymentDeclinedError';
  }
}
