import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import {
  PaymentDeclinedError,
  PaymentProviderError,
  PaymentProviderUnavailableError,
  type AuthorizationResult,
  type CaptureResult,
  type CreateIntentInput,
  type PaymentIntent,
  type PaymentProvider,
  type PaymentWebhookEvent,
  type RefundResult,
} from './payment-provider.port';

interface MockPayment {
  externalPaymentId: string;
  paymentId: string;
  amountMinor: string;
  currency: string;
  authorized: boolean;
  captured: boolean;
  refundedMinor: bigint;
}

/**
 * Test ve yerel geliştirme için deterministik ödeme sağlayıcısı (ADR-0009 §8).
 *
 * Gerçek sağlayıcı sözleşmesi imzalanmadan Faz 5-8'in geliştirilebilmesi için vardır;
 * `PAYMENT_PROVIDER=mock` production'da config seviyesinde reddedilir (env.schema).
 *
 * Gerçek sağlayıcı davranışını **taklit etmesi gereken** üç yön burada bilinçli olarak
 * uygulanmıştır, çünkü bunlar olmadan testler gerçeği ölçmez:
 * 1. Giden çağrılar idempotenttir — aynı anahtarla ikinci çağrı yeni yan etki üretmez.
 * 2. Webhook yükü imzalıdır ve imza adapter içinde doğrulanır.
 * 3. Yetkilendirmenin son kullanma tarihi vardır.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  private readonly payments = new Map<string, MockPayment>();
  /** Giden idempotency: anahtar → o çağrının sonucu. */
  private readonly commandResults = new Map<string, unknown>();
  private unavailable = false;
  private declineNext = false;

  constructor(private readonly config: AppConfigService) {}

  supportsConditionalPayout(): boolean {
    return true;
  }

  /** Yalnızca testler için: sağlayıcı arızası simülasyonu. */
  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  /** Yalnızca testler için: sonraki yetkilendirmenin reddedilmesi. */
  setDeclineNext(decline: boolean): void {
    this.declineNext = decline;
  }

  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    this.assertAvailable();

    return this.idempotent(input.idempotencyKey, () => {
      const externalPaymentId = `mock-pay-${randomUUID()}`;
      this.payments.set(externalPaymentId, {
        externalPaymentId,
        paymentId: input.paymentId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        authorized: false,
        captured: false,
        refundedMinor: 0n,
      });

      return {
        externalPaymentId,
        clientToken: `mock-client-${externalPaymentId}`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      };
    });
  }

  async authorize(input: {
    externalPaymentId: string;
    idempotencyKey: string;
  }): Promise<AuthorizationResult> {
    this.assertAvailable();
    const payment = this.require(input.externalPaymentId);

    if (this.declineNext) {
      this.declineNext = false;
      throw new PaymentDeclinedError('INSUFFICIENT_FUNDS');
    }

    return this.idempotent(input.idempotencyKey, () => {
      payment.authorized = true;
      return {
        externalPaymentId: payment.externalPaymentId,
        authorizedAt: new Date(),
        expiresAt: this.authorizationExpiry(),
        resultCode: 'AUTHORIZED',
      };
    });
  }

  async reauthorize(input: {
    externalPaymentId: string;
    idempotencyKey: string;
  }): Promise<AuthorizationResult> {
    this.assertAvailable();
    const payment = this.require(input.externalPaymentId);

    if (!payment.authorized) {
      throw new PaymentProviderError('NOT_AUTHORIZED', 'payment is not authorized');
    }

    if (this.declineNext) {
      this.declineNext = false;
      throw new PaymentDeclinedError('REAUTHORIZATION_DECLINED');
    }

    return this.idempotent(input.idempotencyKey, () => ({
      externalPaymentId: payment.externalPaymentId,
      authorizedAt: new Date(),
      expiresAt: this.authorizationExpiry(),
      resultCode: 'REAUTHORIZED',
    }));
  }

  async capture(input: {
    externalPaymentId: string;
    amountMinor: string;
    idempotencyKey: string;
  }): Promise<CaptureResult> {
    this.assertAvailable();
    const payment = this.require(input.externalPaymentId);

    if (!payment.authorized) {
      throw new PaymentProviderError('NOT_AUTHORIZED', 'capture before authorization');
    }

    return this.idempotent(input.idempotencyKey, () => {
      payment.captured = true;
      return {
        externalPaymentId: payment.externalPaymentId,
        capturedAt: new Date(),
        resultCode: 'CAPTURED',
      };
    });
  }

  async refund(input: {
    externalPaymentId: string;
    amountMinor: string;
    idempotencyKey: string;
  }): Promise<RefundResult> {
    this.assertAvailable();
    const payment = this.require(input.externalPaymentId);

    return this.idempotent(input.idempotencyKey, () => {
      const requested = BigInt(input.amountMinor);
      if (payment.refundedMinor + requested > BigInt(payment.amountMinor)) {
        throw new PaymentProviderError('REFUND_EXCEEDS_AMOUNT', 'refund exceeds payment amount');
      }
      payment.refundedMinor += requested;

      return {
        externalPaymentId: payment.externalPaymentId,
        refundedMinor: payment.refundedMinor.toString(),
        refundedAt: new Date(),
        resultCode: 'REFUNDED',
      };
    });
  }

  /**
   * İmzalı webhook. Yük biçimi:
   * `{ externalEventId, externalPaymentId, type, sequence?, amountMinor?, occurredAt? }`
   */
  verifyWebhook(rawBody: string, signature: string | undefined): PaymentWebhookEvent {
    if (signature === undefined || !this.isSignatureValid(rawBody, signature)) {
      throw new PaymentProviderError('INVALID_SIGNATURE', 'webhook signature mismatch');
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new PaymentProviderError('INVALID_PAYLOAD', 'webhook payload is not valid JSON');
    }

    const externalEventId = payload.externalEventId;
    const externalPaymentId = payload.externalPaymentId;
    const type = payload.type;

    if (
      typeof externalEventId !== 'string' ||
      externalEventId.length === 0 ||
      typeof externalPaymentId !== 'string' ||
      externalPaymentId.length === 0 ||
      typeof type !== 'string' ||
      type.length === 0
    ) {
      throw new PaymentProviderError('INVALID_PAYLOAD', 'webhook payload is incomplete');
    }

    return {
      externalEventId,
      externalPaymentId,
      type,
      ...(typeof payload.sequence === 'number' ? { sequence: payload.sequence } : {}),
      ...(typeof payload.amountMinor === 'string' ? { amountMinor: payload.amountMinor } : {}),
      ...(typeof payload.occurredAt === 'string'
        ? { occurredAt: new Date(payload.occurredAt) }
        : {}),
      ...(typeof payload.resultCode === 'string' ? { resultCode: payload.resultCode } : {}),
    };
  }

  /** Testlerin imzalı yük üretebilmesi için; gerçek sağlayıcıda karşılığı yoktur. */
  signPayload(rawBody: string): string {
    return createHmac('sha256', this.config.env.PAYMENT_WEBHOOK_SECRET)
      .update(rawBody, 'utf8')
      .digest('hex');
  }

  private isSignatureValid(rawBody: string, signature: string): boolean {
    const expected = Buffer.from(this.signPayload(rawBody), 'utf8');
    const received = Buffer.from(signature, 'utf8');
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  private authorizationExpiry(): Date {
    return new Date(Date.now() + this.config.env.PAYMENT_AUTHORIZATION_TTL_HOURS * 3600 * 1000);
  }

  private assertAvailable(): void {
    if (this.unavailable) {
      throw new PaymentProviderUnavailableError();
    }
  }

  private require(externalPaymentId: string): MockPayment {
    const payment = this.payments.get(externalPaymentId);
    if (payment === undefined) {
      throw new PaymentProviderError('PAYMENT_NOT_FOUND', 'payment not found');
    }
    return payment;
  }

  /**
   * Giden idempotency taklidi: aynı anahtarla ikinci çağrı ilk sonucu döner ve
   * yan etki üretmez. Gerçek sağlayıcılar da bu davranışı verir; mock'ta olmasa
   * "çift çağrı" testleri yanlış yere (yalnızca Emek tarafına) bakardı.
   */
  private idempotent<T>(key: string, produce: () => T): T {
    const cached = this.commandResults.get(key);
    if (cached !== undefined) {
      return cached as T;
    }
    const result = produce();
    this.commandResults.set(key, result);
    return result;
  }
}
