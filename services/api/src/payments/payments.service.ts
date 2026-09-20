import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { AppConfigService } from '../common/config/app-config.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { EventType, OutboxService } from '../common/outbox/outbox.service';
import { BookingStateService } from '../bookings/state/booking-state.service';
import { blocksPaymentRelease, type BookingStatus } from '../bookings/state/booking-status';
import {
  PAYMENT_PROVIDER,
  PaymentDeclinedError,
  PaymentProviderError,
  PaymentProviderUnavailableError,
  type PaymentOperation,
  type PaymentProvider,
  type PaymentWebhookEvent,
} from './payment-provider.port';
import { PaymentsRepository, type Payment } from './payments.repository';
import { holdsAuthorization, type PaymentStatus } from './state/payment-status';
import {
  findPaymentTransition,
  isBackwardProgress,
  isSourceAllowed,
} from './state/payment-transitions';

export interface PaymentIntentView {
  paymentId: string;
  clientToken: string;
  amountMinor: string;
  currency: string;
  status: PaymentStatus;
  expiresAt: Date;
}

interface BookingContext {
  id: string;
  customerId: string;
  providerId: string | null;
  status: BookingStatus;
  priceMinor: string;
  currency: string;
}

/**
 * Bir giden ödeme komutunun "hâlâ uçuşta" sayılacağı süre.
 *
 * Bu süre dolmadan aynı komut yeniden denenmez (eşzamanlı çift gönderim); süre dolunca
 * **aynı** idempotency anahtarıyla yeniden denenir (ADR-0017 §4). Idempotency
 * altyapısındaki `IN_PROGRESS_LEASE_SECONDS` ile aynı mantık.
 */
const COMMAND_LEASE_SECONDS = 60;

/**
 * Release engeli: gerekçe audit'e yazılıp **commit edilir**, hata dışarıda üretilir.
 */
interface ReleaseBlock {
  code: typeof ErrorCode.PAYMENT_RELEASE_BLOCKED | typeof ErrorCode.PAYMENT_AUTHORIZATION_EXPIRED;
  details: Record<string, unknown>;
}

type ReleasePreparation =
  | { kind: 'BLOCKED'; block: ReleaseBlock }
  | { kind: 'READY'; payment: Payment; key: string; commandId: string };

/** Webhook sonucu: sağlayıcıya her durumda 200 döner, yan etki üretilip üretilmediği burada. */
export interface WebhookOutcome {
  /** `false` ise olay zaten işlenmişti ya da uygulanmadı (out-of-order/bilinmeyen ödeme). */
  applied: boolean;
  reason?: 'DUPLICATE' | 'UNKNOWN_PAYMENT' | 'OUT_OF_ORDER' | 'INVALID_TRANSITION';
}

/**
 * Ödeme orkestrasyonu (ADR-0009).
 *
 * Üç kural bu sınıfın şeklini belirler:
 *
 * 1. **Para hareketi event'ten tetiklenmez.** Sağlayıcıya giden `authorize`/`capture`
 *    çağrıları senkron akıştan çağrılır ve her biri `payment_commands`'ta önceden
 *    rezerve edilmiş bir idempotency key taşır (§5, §6, T-38).
 * 2. **Gelen webhook idempotenttir.** Aynı `external_event_id` ikinci kez yan etki
 *    üretmez ve geri durum geçişi reddedilir (§7, T-09, T-10).
 * 3. **Release bloklanabilir.** Açık uyuşmazlık, `SAFETY_HOLD` veya süresi dolmuş
 *    yetkilendirme varken para serbest bırakılmaz (§4, §9, T-11, T-34).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repository: PaymentsRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
    private readonly bookingState: BookingStateService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * Ödeme niyeti oluşturur ve yetkilendirmeyi alır.
   *
   * Tutar **rezervasyondan** okunur; istemci tutar göndermez (Faz 4'teki fiyat
   * bulgusunun aynısı burada da geçerlidir).
   *
   * Sağlayıcı çağrısı transaction **dışında** yapılır: ağ çağrısını transaction içinde
   * tutmak, PSP yavaşladığında veritabanı bağlantılarını ve kilitleri bloklardı.
   * Doğruluğu `payment_commands` rezervasyonu korur.
   */
  async authorizeForBooking(input: {
    bookingId: string;
    userId: string;
  }): Promise<PaymentIntentView> {
    const booking = await this.loadBookingForCustomer(input.bookingId, input.userId);

    // Sıra önemli: yetkilendirme alındığında rezervasyon `SCHEDULED` olur, yani ikinci
    // deneme durum kontrolüne takılır ve istemci "geçersiz durum" görürdü. Asıl neden
    // ödemenin zaten alınmış olmasıdır; önce o söylenir.
    const existing = await this.repository.findLiveForBooking(booking.id);
    if (existing !== null && existing.status !== 'CREATED') {
      // Zaten yetkilendirilmiş: ikinci bir hold müşterinin limitini iki kez bloke eder.
      throw new BusinessException(ErrorCode.PAYMENT_ALREADY_AUTHORIZED);
    }

    // Yetkilendirme yalnızca sağlayıcı kabul ettikten sonra alınır: daha önce
    // alınmış bir hold, eşleşme başarısız olursa boşa tutulmuş para demektir.
    if (booking.status !== 'CONFIRMED') {
      throw new BusinessException(ErrorCode.INVALID_STATE_TRANSITION, {
        clientMessage: 'Ödeme yalnızca sağlayıcı onayından sonra alınabilir.',
        details: { bookingStatus: booking.status },
      });
    }

    const payment =
      existing ??
      (await this.uow.withTransaction((client) =>
        this.repository.create(client, {
          bookingId: booking.id,
          provider: this.provider.name,
          amountMinor: booking.priceMinor,
          currency: booking.currency,
        }),
      ));

    // Her sağlayıcı çağrısının **kendi** anahtarı olur. Tek anahtarı iki farklı işlem
    // için kullanmak, sağlayıcının ikinci çağrıya birincinin sonucunu döndürmesine yol
    // açar (idempotency sözleşmesi budur) — yani yetkilendirme hiç yapılmamış olur.
    const intentKey = this.idempotencyKey(payment.id, 'CREATE_INTENT', 1);
    const authorizeKey = this.idempotencyKey(payment.id, 'AUTHORIZE', 1);

    // Rezervasyon **para hareketi** üzerinedir: intent oluşturmak para hareketi değildir,
    // ikinci yetkilendirme denemesi burada durur (T-38).
    const reservation = await this.uow.withTransaction((client) =>
      this.repository.reserveCommand(client, {
        paymentId: payment.id,
        operation: 'AUTHORIZE',
        attempt: 1,
        idempotencyKey: authorizeKey,
      }),
    );

    if (reservation.outcome === 'ALREADY_SENT') {
      // Aynı yetkilendirme daha önce gönderilmiş: ikinci kez gönderilmez (T-38).
      throw new BusinessException(ErrorCode.PAYMENT_ALREADY_AUTHORIZED);
    }

    let intent;
    let authorization;
    try {
      intent = await this.provider.createIntent({
        paymentId: payment.id,
        bookingId: booking.id,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        idempotencyKey: intentKey,
      });
      authorization = await this.provider.authorize({
        externalPaymentId: intent.externalPaymentId,
        idempotencyKey: authorizeKey,
      });
    } catch (error) {
      await this.recordCommandFailure(payment.id, reservation.commandId, error);
      throw this.translateProviderError(error);
    }

    await this.uow.withTransaction(async (client) => {
      await this.repository.completeCommand(client, {
        commandId: reservation.commandId,
        status: 'SUCCEEDED',
        resultCode: authorization.resultCode,
      });

      await this.applyTransition(client, {
        payment,
        to: 'AUTHORIZED',
        source: 'COMMAND',
        externalPaymentId: intent.externalPaymentId,
        authorizedAt: authorization.authorizedAt,
        authorizationExpiresAt: authorization.expiresAt,
        actorUserId: input.userId,
      });

      // Yetkilendirme alındı: para hizmet gününe kadar tutulur.
      const authorized = await this.repository.findByIdLocked(client, payment.id);
      if (authorized === null) {
        throw new Error('yetkilendirilen ödeme okunamadı');
      }
      await this.applyTransition(client, { payment: authorized, to: 'HELD', source: 'COMMAND' });

      // Booking de ilerletilir ve **aynı** state machine'den geçer: ödeme modülüne
      // özel bir "içeriden güncelleme" yolu açmak transition map'i atlatılabilir kılardı.
      await this.bookingState.transition(client, {
        bookingId: booking.id,
        to: 'PAYMENT_AUTHORIZED',
        actor: 'SYSTEM',
      });
      await this.bookingState.transition(client, {
        bookingId: booking.id,
        to: 'SCHEDULED',
        actor: 'SYSTEM',
      });

      await this.outbox.enqueue(client, {
        eventType: EventType.PAYMENT_AUTHORIZED,
        subjectType: 'payment',
        subjectId: payment.id,
        payload: {
          paymentId: payment.id,
          bookingId: booking.id,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
        },
      });
    });

    return {
      paymentId: payment.id,
      clientToken: intent.clientToken,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      status: 'HELD',
      expiresAt: authorization.expiresAt,
    };
  }

  /**
   * Yetkilendirmeyi yeniler (ADR-0009 §4).
   *
   * Hizmet günü, yetkilendirmenin geçerlilik süresinden sonraya düşebilir. Yenileme
   * olmadan release anında sağlayıcı reddeder ve rezervasyon ödenmemiş kalır.
   *
   * Her yenileme **yeni bir attempt** numarası kullanır: aynı anahtarla ikinci çağrı
   * sağlayıcıda eski sonucu döndürürdü, yani süre hiç uzamazdı.
   */
  async reauthorize(paymentId: string): Promise<Payment> {
    const current = await this.uow.withTransaction((client) =>
      this.repository.findByIdLocked(client, paymentId),
    );

    if (current === null) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }
    if (!holdsAuthorization(current.status) || current.externalPaymentId === null) {
      throw new BusinessException(ErrorCode.INVALID_STATE_TRANSITION, {
        details: { status: current.status },
      });
    }
    if (current.reauthorizationCount >= this.config.env.PAYMENT_MAX_REAUTHORIZATIONS) {
      // Sınırsız yenileme, ödemeyi sonsuza kadar askıda tutmanın yolu olurdu.
      throw new BusinessException(ErrorCode.PAYMENT_REAUTHORIZATION_EXHAUSTED);
    }

    const attempt = current.reauthorizationCount + 2;
    const key = this.idempotencyKey(current.id, 'REAUTHORIZE', attempt);

    const reservation = await this.uow.withTransaction((client) =>
      this.repository.reserveCommand(client, {
        paymentId: current.id,
        operation: 'REAUTHORIZE',
        attempt,
        idempotencyKey: key,
      }),
    );
    if (reservation.outcome === 'ALREADY_SENT') {
      throw new BusinessException(ErrorCode.PAYMENT_COMMAND_IN_FLIGHT);
    }

    let result;
    try {
      result = await this.provider.reauthorize({
        externalPaymentId: current.externalPaymentId,
        idempotencyKey: key,
      });
    } catch (error) {
      await this.recordCommandFailure(current.id, reservation.commandId, error);
      throw this.translateProviderError(error);
    }

    return this.uow.withTransaction(async (client) => {
      await this.repository.completeCommand(client, {
        commandId: reservation.commandId,
        status: 'SUCCEEDED',
        resultCode: result.resultCode,
      });

      await this.repository.updateStatus(client, {
        paymentId: current.id,
        // Durum değişmez; yenilenen yalnızca süredir.
        status: current.status,
        authorizedAt: result.authorizedAt,
        authorizationExpiresAt: result.expiresAt,
        incrementReauthorization: true,
      });

      await this.audit.record(client, {
        action: AuditAction.PAYMENT_REAUTHORIZED,
        entityType: 'payment',
        entityId: current.id,
        oldValue: { authorizationExpiresAt: current.authorizationExpiresAt?.toISOString() ?? null },
        newValue: { authorizationExpiresAt: result.expiresAt.toISOString(), attempt },
      });

      const updated = await this.repository.findByIdLocked(client, current.id);
      if (updated === null) {
        throw new Error('yenilenen ödeme okunamadı');
      }
      return updated;
    });
  }

  /**
   * Ödemeyi serbest bırakır (capture + release).
   *
   * Bloklayıcı kontroller **tek yerde** ve kilit altında yapılır: booking durumu,
   * açık uyuşmazlık ve yetkilendirme süresi. Bu kontrolleri çağıranlara dağıtmak,
   * bir çağrı yolunun kontrolü atlamasına açık kapı bırakırdı.
   */
  async release(input: { paymentId: string; actorUserId?: string }): Promise<Payment> {
    const prepared = await this.uow.withTransaction<ReleasePreparation>(async (client) => {
      const payment = await this.repository.findByIdLocked(client, input.paymentId);
      if (payment === null) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }

      // Sıra önemli: blok kontrolleri **durum geçerliliğinden önce** gelir. Uyuşmazlık
      // veya güvenlik askısı ödemeyi `DISPUTED` yapar; geçerlilik kontrolü önce
      // çalışsaydı operatör "geçersiz durum" hatası görür, gerçek sebebi göremezdi.
      const block = await this.evaluateReleaseBlock(client, payment);
      if (block !== null) {
        return { kind: 'BLOCKED', block };
      }

      this.assertReleasableState(payment);

      const command = await this.claimCommand(client, payment.id, 'CAPTURE');

      // `RELEASE_PENDING`: çağrı gönderilmek üzere. Süreç bu noktadan sonra çökerse
      // mutabakat işi (Faz 11) ödemeyi bu durumda bulur ve sağlayıcıya sorar —
      // "gönderildi mi bilmiyorum" durumu kayıt altındadır.
      if (payment.status !== 'RELEASE_PENDING') {
        await this.applyTransition(client, {
          payment,
          to: 'RELEASE_PENDING',
          source: 'COMMAND',
          ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
        });
      }

      return { kind: 'READY', payment, key: command.key, commandId: command.commandId };
    });

    // Blok gerekçesi commit edildikten sonra hata üretilir.
    if (prepared.kind === 'BLOCKED') {
      throw new BusinessException(prepared.block.code, { details: prepared.block.details });
    }

    let capture;
    try {
      capture = await this.provider.capture({
        externalPaymentId: prepared.payment.externalPaymentId as string,
        amountMinor: prepared.payment.amountMinor,
        idempotencyKey: prepared.key,
      });
    } catch (error) {
      await this.recordCommandFailure(prepared.payment.id, prepared.commandId, error);
      throw this.translateProviderError(error);
    }

    return this.uow.withTransaction(async (client) => {
      await this.repository.completeCommand(client, {
        commandId: prepared.commandId,
        status: 'SUCCEEDED',
        resultCode: capture.resultCode,
      });

      const locked = await this.repository.findByIdLocked(client, prepared.payment.id);
      if (locked === null) {
        throw new Error('ödeme okunamadı');
      }

      await this.applyTransition(client, {
        payment: locked,
        to: 'RELEASED',
        source: 'COMMAND',
        ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
      });

      // Para çıktı: rezervasyon `SETTLED` olur. Bu geçiş yalnızca burada yapılır —
      // "ödenmiş" bilgisi booking'e başka bir yoldan yazılabilse, hiç para çıkmadan
      // mutabakatlanmış bir rezervasyon üretilebilirdi.
      const bookingStatus = await client.query<{ status: BookingStatus }>(
        `SELECT status FROM bookings WHERE id = $1 FOR UPDATE`,
        [locked.bookingId],
      );
      if (bookingStatus.rows[0]?.status === 'COMPLETED') {
        await this.bookingState.transition(client, {
          bookingId: locked.bookingId,
          to: 'SETTLED',
          actor: 'SYSTEM',
        });
      }

      await this.outbox.enqueue(client, {
        eventType: EventType.PAYMENT_RELEASED,
        subjectType: 'payment',
        subjectId: locked.id,
        payload: {
          paymentId: locked.id,
          bookingId: locked.bookingId,
          amountMinor: locked.amountMinor,
        },
      });

      const released = await this.repository.findByIdLocked(client, locked.id);
      if (released === null) {
        throw new Error('serbest bırakılan ödeme okunamadı');
      }
      return released;
    });
  }

  /** İade (uyuşmazlık kararı veya iptal sonucu). Kısmi iade desteklenir. */
  async refund(input: {
    paymentId: string;
    amountMinor?: string;
    actorUserId: string;
    reason: string;
  }): Promise<Payment> {
    const prepared = await this.uow.withTransaction(async (client) => {
      const payment = await this.repository.findByIdLocked(client, input.paymentId);
      if (payment === null) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }
      if (payment.externalPaymentId === null) {
        throw new BusinessException(ErrorCode.INVALID_STATE_TRANSITION, {
          details: { status: payment.status },
        });
      }

      const remaining = BigInt(payment.amountMinor) - BigInt(payment.refundedMinor);
      const requested = input.amountMinor === undefined ? remaining : BigInt(input.amountMinor);

      if (requested <= 0n || requested > remaining) {
        throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
          clientMessage: 'İade tutarı geçersiz.',
          details: { remainingMinor: remaining.toString() },
        });
      }

      const command = await this.claimCommand(client, payment.id, 'REFUND');

      return { payment, requested, key: command.key, commandId: command.commandId };
    });

    let refundResult;
    try {
      refundResult = await this.provider.refund({
        externalPaymentId: prepared.payment.externalPaymentId as string,
        amountMinor: prepared.requested.toString(),
        idempotencyKey: prepared.key,
      });
    } catch (error) {
      await this.recordCommandFailure(prepared.payment.id, prepared.commandId, error);
      throw this.translateProviderError(error);
    }

    return this.uow.withTransaction(async (client) => {
      await this.repository.completeCommand(client, {
        commandId: prepared.commandId,
        status: 'SUCCEEDED',
        resultCode: refundResult.resultCode,
      });

      const locked = await this.repository.findByIdLocked(client, prepared.payment.id);
      if (locked === null) {
        throw new Error('ödeme okunamadı');
      }

      const totalRefunded = BigInt(locked.refundedMinor) + prepared.requested;
      const fullyRefunded = totalRefunded >= BigInt(locked.amountMinor);

      if (fullyRefunded) {
        await this.applyTransition(client, {
          payment: locked,
          to: 'REFUNDED',
          source: 'COMMAND',
          refundedMinor: totalRefunded.toString(),
          actorUserId: input.actorUserId,
          reason: input.reason,
        });
      } else {
        // Kısmi iade durumu değiştirmez: ödeme hâlâ canlıdır (ADR-0017 §3).
        await this.repository.updateStatus(client, {
          paymentId: locked.id,
          status: locked.status,
          refundedMinor: totalRefunded.toString(),
        });

        await this.audit.record(client, {
          action: AuditAction.PAYMENT_REFUNDED,
          entityType: 'payment',
          entityId: locked.id,
          actorUserId: input.actorUserId,
          oldValue: { refundedMinor: locked.refundedMinor },
          newValue: {
            refundedMinor: totalRefunded.toString(),
            partial: true,
            reason: input.reason,
          },
        });
      }

      await this.outbox.enqueue(client, {
        eventType: EventType.PAYMENT_REFUNDED,
        subjectType: 'payment',
        subjectId: locked.id,
        payload: {
          paymentId: locked.id,
          bookingId: locked.bookingId,
          refundedMinor: totalRefunded.toString(),
          partial: !fullyRefunded,
        },
      });

      const updated = await this.repository.findByIdLocked(client, locked.id);
      if (updated === null) {
        throw new Error('iade edilen ödeme okunamadı');
      }
      return updated;
    });
  }

  /**
   * Sağlayıcı webhook'unu işler (ADR-0009 §7).
   *
   * Sıra: imza doğrula → olayı INSERT etmeye çalış → çakışma varsa **hiçbir yan etki
   * üretmeden** başarı dön → yeni ise aynı transaction'da durum geçişini uygula.
   *
   * Webhook **para hareketi başlatmaz**: yalnızca Emek'in bildiği durumu sağlayıcının
   * bildirdiğiyle hizalar. `capture` çağrısı buradan yapılmaz (§6).
   */
  async handleWebhook(rawBody: string, signature: string | undefined): Promise<WebhookOutcome> {
    let event: PaymentWebhookEvent;
    try {
      event = this.provider.verifyWebhook(rawBody, signature);
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        // İmza hatası ile bilinmeyen ödeme aynı yanıtı döner: sağlayıcı tarafındaki
        // bir saldırgana hangi ödemelerin var olduğu sızdırılmaz.
        throw new BusinessException(ErrorCode.PAYMENT_WEBHOOK_REJECTED);
      }
      throw error;
    }

    return this.uow.withTransaction(async (client) => {
      const payment = await this.repository.findByExternalIdLocked(
        client,
        this.provider.name,
        event.externalPaymentId,
      );

      const eventId = await this.repository.insertEvent(client, {
        provider: this.provider.name,
        externalEventId: event.externalEventId,
        eventType: event.type,
        ...(payment !== null ? { paymentId: payment.id } : {}),
        ...(event.sequence !== undefined ? { providerSequence: event.sequence } : {}),
        ...(event.occurredAt !== undefined ? { occurredAt: event.occurredAt } : {}),
        summary: { type: event.type, resultCode: event.resultCode ?? null },
      });

      // UNIQUE çakışması: olay daha önce işlendi. İkinci kez hiçbir yan etki üretilmez (T-09).
      if (eventId === null) {
        return { applied: false, reason: 'DUPLICATE' as const };
      }

      if (payment === null) {
        // Bilinmeyen ödeme: olay kayıtlı kalır (mutabakat için) ama uygulanmaz.
        return { applied: false, reason: 'UNKNOWN_PAYMENT' as const };
      }

      const target = this.statusForWebhook(event.type);
      if (target === null) {
        return { applied: false, reason: 'INVALID_TRANSITION' as const };
      }

      if (payment.status === target) {
        // Aynı duruma ikinci bildirim: yan etki yok.
        return { applied: false, reason: 'DUPLICATE' as const };
      }

      // Out-of-order teslim: gecikmiş bir olay ödemeyi geriye çekmez (T-10).
      if (isBackwardProgress(payment.status, target)) {
        await this.audit.record(client, {
          action: AuditAction.PAYMENT_EVENT_REJECTED,
          entityType: 'payment',
          entityId: payment.id,
          newValue: { reason: 'OUT_OF_ORDER', from: payment.status, to: target },
        });
        return { applied: false, reason: 'OUT_OF_ORDER' as const };
      }

      const rule = findPaymentTransition(payment.status, target);
      if (rule === undefined || !isSourceAllowed(rule, 'WEBHOOK')) {
        await this.audit.record(client, {
          action: AuditAction.PAYMENT_EVENT_REJECTED,
          entityType: 'payment',
          entityId: payment.id,
          newValue: { reason: 'INVALID_TRANSITION', from: payment.status, to: target },
        });
        return { applied: false, reason: 'INVALID_TRANSITION' as const };
      }

      await this.applyTransition(client, {
        payment,
        to: target,
        source: 'WEBHOOK',
        ...(target === 'AUTHORIZED'
          ? {
              authorizedAt: event.occurredAt ?? new Date(),
              authorizationExpiresAt: new Date(
                Date.now() + this.config.env.PAYMENT_AUTHORIZATION_TTL_HOURS * 3600 * 1000,
              ),
            }
          : {}),
        ...(target === 'REFUNDED' && event.amountMinor !== undefined
          ? { refundedMinor: event.amountMinor }
          : {}),
      });

      await this.repository.markEventApplied(client, {
        eventId,
        paymentId: payment.id,
        fromStatus: payment.status,
        toStatus: target,
      });

      return { applied: true };
    });
  }

  /**
   * Hizmet tamamlandı bildirimi (booking `COMPLETED` olduğunda).
   *
   * Yalnızca durumu ilerletir; **para hareketi başlatmaz**. Release ayrı ve açık bir
   * karardır (operatör veya zamanlanmış iş) — hizmet tamamlandı diye para otomatik
   * çıksa, uyuşmazlık penceresi hiç olmazdı.
   */
  async markServiceCompleted(client: PoolClient, bookingId: string): Promise<void> {
    const payment = await this.repository.findLiveForBooking(bookingId, client);
    if (payment === null || payment.status !== 'HELD') {
      return;
    }

    await this.applyTransition(client, { payment, to: 'SERVICE_COMPLETED', source: 'SYSTEM' });
  }

  /**
   * Rezervasyon `SETTLED` olabilir mi?
   *
   * Booking akışı bu kontrolü `SETTLED` geçişinden önce çağırır: para serbest
   * bırakılmamışken mutabakatlanmış görünen bir rezervasyon, sağlayıcıya ödeme
   * yapıldığı izlenimi verirdi.
   */
  async assertSettlementAllowed(client: PoolClient, bookingId: string): Promise<void> {
    const payment = await this.repository.findLiveForBooking(bookingId, client);

    if (payment === null || payment.status !== 'RELEASED') {
      throw new BusinessException(ErrorCode.PAYMENT_NOT_RELEASED, {
        details: { paymentStatus: payment?.status ?? null },
      });
    }
  }

  /** Uyuşmazlık açıldığında ödemeyi dondurur (ADR-0009 §9). */
  async freezeForDispute(client: PoolClient, bookingId: string): Promise<void> {
    const payment = await this.repository.findLiveForBooking(bookingId, client);
    if (payment === null || payment.status === 'DISPUTED') {
      return;
    }

    const rule = findPaymentTransition(payment.status, 'DISPUTED');
    if (rule === undefined) {
      // Henüz yetkilendirilmemiş ödeme dondurulamaz; dondurulacak para yoktur.
      return;
    }

    // Dondurma öncesi durum saklanır: çözümde buraya dönülür. Saklanmasaydı tek bir
    // geri dönüş durumu seçmek zorunda kalırdık ve diğer senaryoda para kilitlenirdi
    // (Faz 5 review bulgusu C2).
    await this.applyTransition(client, {
      payment,
      to: 'DISPUTED',
      source: 'SYSTEM',
      frozenFromStatus: payment.status,
    });
  }

  /**
   * Dondurulmuş ödemeyi çözer: uyuşmazlık karara bağlandığında veya güvenlik askısı
   * kaldırıldığında çağrılır.
   *
   * Ödeme **dondurulduğu duruma** döner; oradan normal akış (ve tüm release guard'ları)
   * yeniden geçerlidir. Çözüm yolu olmasaydı, sağlayıcı lehine karar verilmiş bir
   * uyuşmazlıkta para ne serbest bırakılabilir ne iade edilebilirdi — hizmeti tamamlamış
   * sağlayıcının parası kalıcı olarak kilitli kalırdı (Faz 5 review bulgusu C2).
   *
   * Başka bir **açık** uyuşmazlık varsa çözülmez: ilk karar ikinciyi geçersiz kılamaz.
   */
  async unfreeze(client: PoolClient, bookingId: string): Promise<void> {
    const payment = await this.repository.findLiveForBooking(bookingId, client);
    if (payment === null || payment.status !== 'DISPUTED') {
      return;
    }

    const stillOpen = await client.query<{ id: string }>(
      `SELECT id FROM disputes
        WHERE booking_id = $1 AND status IN ('OPEN', 'UNDER_REVIEW')
        LIMIT 1`,
      [bookingId],
    );
    if (stillOpen.rowCount !== null && stillOpen.rowCount > 0) {
      return;
    }

    const target = payment.frozenFromStatus;
    if (target === null || findPaymentTransition('DISPUTED', target) === undefined) {
      // Kaynağı bilinmeyen bir dondurma çözülemez; CHECK bunu zaten engeller, burada
      // sessizce yanlış bir duruma dönmek yerine hiçbir şey yapılmaz.
      return;
    }

    await this.applyTransition(client, { payment, to: target, source: 'COMMAND' });
  }

  /**
   * Süresi dolmuş yetkilendirmeleri işaretler.
   *
   * Zamanlanmış iş olarak çalışır (Faz 9'da scheduler'a bağlanır). `AUTHORIZATION_EXPIRED`
   * bir gerçektir: yetkilendirme sağlayıcı tarafında zaten geçersizdir, Emek'in bunu
   * kaydetmemesi yalnızca release anında sürpriz üretir.
   */
  async expireStaleAuthorizations(limit = 100): Promise<number> {
    const candidates = await this.repository.findExpiringAuthorizations(0, limit);
    let expired = 0;

    for (const candidate of candidates) {
      const applied = await this.uow.withTransaction(async (client) => {
        const payment = await this.repository.findByIdLocked(client, candidate.id);
        if (
          payment === null ||
          payment.authorizationExpiresAt === null ||
          payment.authorizationExpiresAt.getTime() > Date.now() ||
          !holdsAuthorization(payment.status)
        ) {
          return false;
        }

        await this.applyTransition(client, {
          payment,
          to: 'AUTHORIZATION_EXPIRED',
          source: 'SYSTEM',
          failureCode: 'AUTHORIZATION_EXPIRED',
        });
        return true;
      });

      if (applied) {
        expired += 1;
      }
    }

    return expired;
  }

  /** Re-authorization gerektiren ödemeler (zamanlanmış iş için aday listesi). */
  findPaymentsNeedingReauthorization(limit = 100): Promise<Payment[]> {
    return this.repository.findExpiringAuthorizations(
      this.config.env.PAYMENT_REAUTH_THRESHOLD_HOURS,
      limit,
    );
  }

  /** Taraf olan kullanıcıya ödemeyi gösterir; taraf olmayan 404 alır. */
  findForBooking(bookingId: string, userId: string): Promise<Payment | null> {
    return this.repository.findForBookingAsParticipant(bookingId, userId);
  }

  /**
   * Durum geçerliliği. Burada audit yazılmaz, bu yüzden doğrudan fırlatılabilir.
   */
  private assertReleasableState(payment: Payment): void {
    if (payment.externalPaymentId === null || !holdsAuthorization(payment.status)) {
      throw new BusinessException(ErrorCode.INVALID_STATE_TRANSITION, {
        details: { status: payment.status },
      });
    }
  }

  /**
   * Release'i **bloklayan** gerçekler: rezervasyonun güvenlik/uyuşmazlık durumu, açık
   * bir uyuşmazlık kaydı, dondurulmuş ödeme ve süresi dolmuş yetkilendirme.
   *
   * Gerekçe audit'e yazılır ama hata burada **fırlatılmaz**: fırlatılsaydı rollback ile
   * birlikte "neden bloklandı" kaydı da kaybolurdu (Faz 3'te aynı hata kimlik akışında
   * görülmüştü). Karar çağırana döner, commit edilir, hata dışarıda üretilir.
   */
  private async evaluateReleaseBlock(
    client: PoolClient,
    payment: Payment,
  ): Promise<ReleaseBlock | null> {
    if (payment.status === 'RELEASED') {
      throw new BusinessException(ErrorCode.PAYMENT_ALREADY_RELEASED);
    }

    const booking = await client.query<{ status: BookingStatus }>(
      `SELECT status FROM bookings WHERE id = $1 FOR SHARE`,
      [payment.bookingId],
    );
    const bookingStatus = booking.rows[0]?.status;
    if (bookingStatus === undefined) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }

    // `SAFETY_HOLD` / `DISPUTED`: kural booking state machine'inde tanımlıdır, burada
    // yeniden yazılmaz (ADR-0006 §6).
    if (blocksPaymentRelease(bookingStatus)) {
      return this.recordBlock(client, payment, ErrorCode.PAYMENT_RELEASE_BLOCKED, {
        reason: 'BOOKING_STATUS',
        bookingStatus,
      });
    }

    // Açık uyuşmazlık, booking durumundan bağımsız olarak bloklar: uyuşmazlık kaydı
    // açılmışken booking hâlâ `COMPLETED` görünebilir.
    const openDispute = await client.query<{ id: string }>(
      `SELECT id FROM disputes
        WHERE booking_id = $1 AND status IN ('OPEN', 'UNDER_REVIEW')
        LIMIT 1 FOR SHARE`,
      [payment.bookingId],
    );
    if (openDispute.rowCount !== null && openDispute.rowCount > 0) {
      return this.recordBlock(client, payment, ErrorCode.PAYMENT_RELEASE_BLOCKED, {
        reason: 'OPEN_DISPUTE',
        disputeId: openDispute.rows[0]?.id ?? null,
      });
    }

    // Ödeme dondurulmuşsa (uyuşmazlık/güvenlik) çözüm kararı verilmeden release olmaz.
    if (payment.status === 'DISPUTED') {
      return this.recordBlock(client, payment, ErrorCode.PAYMENT_RELEASE_BLOCKED, {
        reason: 'PAYMENT_DISPUTED',
      });
    }

    // ADR-0009 §4: süresi dolmuş yetkilendirmede release **denenmez**. Denenirse
    // sağlayıcı reddeder ve sebep kullanıcıya anlamsız bir hata olarak görünürdü.
    if (
      payment.authorizationExpiresAt !== null &&
      payment.authorizationExpiresAt.getTime() <= Date.now()
    ) {
      return this.recordBlock(client, payment, ErrorCode.PAYMENT_AUTHORIZATION_EXPIRED, {
        reason: 'AUTHORIZATION_EXPIRED',
        expiredAt: payment.authorizationExpiresAt.toISOString(),
      });
    }

    return null;
  }

  private async recordBlock(
    client: PoolClient,
    payment: Payment,
    code: ReleaseBlock['code'],
    details: Record<string, unknown>,
  ): Promise<ReleaseBlock> {
    await this.audit.record(client, {
      action: AuditAction.PAYMENT_RELEASE_BLOCKED,
      entityType: 'payment',
      entityId: payment.id,
      newValue: details,
    });
    return { code, details };
  }

  /**
   * Ödeme durum geçişinin **tek** yolu: kuralı doğrular, yazar, audit'ler.
   *
   * `bookings.status` için `BookingStateService` ne ise `payments.status` için budur.
   */
  private async applyTransition(
    client: PoolClient,
    input: {
      payment: Payment;
      to: PaymentStatus;
      source: 'COMMAND' | 'WEBHOOK' | 'SYSTEM';
      externalPaymentId?: string;
      authorizedAt?: Date;
      authorizationExpiresAt?: Date;
      refundedMinor?: string;
      failureCode?: string;
      frozenFromStatus?: PaymentStatus;
      actorUserId?: string;
      reason?: string;
    },
  ): Promise<void> {
    const from = input.payment.status;
    const rule = findPaymentTransition(from, input.to);

    if (rule === undefined || !isSourceAllowed(rule, input.source)) {
      throw new BusinessException(ErrorCode.INVALID_STATE_TRANSITION, {
        details: { from, to: input.to, source: input.source },
      });
    }

    await this.repository.updateStatus(client, {
      paymentId: input.payment.id,
      status: input.to,
      ...(input.externalPaymentId !== undefined
        ? { externalPaymentId: input.externalPaymentId }
        : {}),
      ...(input.authorizedAt !== undefined ? { authorizedAt: input.authorizedAt } : {}),
      ...(input.authorizationExpiresAt !== undefined
        ? { authorizationExpiresAt: input.authorizationExpiresAt }
        : {}),
      ...(input.refundedMinor !== undefined ? { refundedMinor: input.refundedMinor } : {}),
      ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {}),
      ...(input.frozenFromStatus !== undefined ? { frozenFromStatus: input.frozenFromStatus } : {}),
    });

    await this.audit.record(client, {
      action: AuditAction.PAYMENT_STATUS_CHANGED,
      entityType: 'payment',
      entityId: input.payment.id,
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
      oldValue: { status: from },
      newValue: {
        status: input.to,
        source: input.source,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    });
  }

  private async loadBookingForCustomer(bookingId: string, userId: string): Promise<BookingContext> {
    const rows = await this.uow.query<{
      id: string;
      customer_id: string;
      provider_id: string | null;
      status: BookingStatus;
      price_minor: string;
      currency: string;
    }>(
      `SELECT id, customer_id, provider_id, status, price_minor, currency
         FROM bookings WHERE id = $1 AND customer_id = $2`,
      [bookingId, userId],
    );

    const row = rows[0];
    if (row === undefined) {
      // Ödemeyi yalnızca müşteri başlatır; başkasına varlık bilgisi verilmez.
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }

    return {
      id: row.id,
      customerId: row.customer_id,
      providerId: row.provider_id,
      status: row.status,
      priceMinor: row.price_minor,
      currency: row.currency,
    };
  }

  /**
   * Giden çağrı için komut satırı edinir.
   *
   * **Sonucu bilinmeyen bir çağrı asla yeni anahtarla tekrarlanmaz.** Sağlayıcıya ulaşmış
   * ama yanıtı kaybolmuş bir `capture`/`refund`, yeni bir idempotency anahtarıyla tekrar
   * gönderilseydi sağlayıcı bunu **yeni bir işlem** sayar ve para ikinci kez hareket
   * ederdi (Faz 5 review bulgusu C1). Bu yüzden:
   *
   * - Kiralama süresi dolmuş `PENDING` satır varsa **aynı satır ve aynı anahtar** yeniden
   *   kullanılır; mükerrer çağrıyı sağlayıcı kendi idempotency'siyle eler.
   * - Kiralama süresi dolmamış `PENDING` satır **hâlâ uçuşta**dır: eşzamanlı ikinci istek
   *   reddedilir.
   * - Yeni anahtar yalnızca sağlayıcı **kesin** olarak reddettiğinde (komut `FAILED`)
   *   üretilir; o durumda sağlayıcı hiçbir şey işlememiştir.
   */
  private async claimCommand(
    client: PoolClient,
    paymentId: string,
    operation: PaymentOperation,
  ): Promise<{ commandId: string; key: string }> {
    const reusable = await this.repository.findReusableCommand(client, {
      paymentId,
      operation,
      leaseSeconds: COMMAND_LEASE_SECONDS,
    });

    if (reusable !== null) {
      if (reusable.inFlight) {
        throw new BusinessException(ErrorCode.PAYMENT_COMMAND_IN_FLIGHT);
      }
      return { commandId: reusable.commandId, key: reusable.idempotencyKey };
    }

    const attempt = (await this.repository.countCommands(paymentId, operation)) + 1;
    const key = this.idempotencyKey(paymentId, operation, attempt);
    const reservation = await this.repository.reserveCommand(client, {
      paymentId,
      operation,
      attempt,
      idempotencyKey: key,
    });

    if (reservation.outcome === 'ALREADY_SENT') {
      // Aynı anahtar başka bir transaction tarafından rezerve edilmiş.
      throw new BusinessException(ErrorCode.PAYMENT_COMMAND_IN_FLIGHT);
    }

    return { commandId: reservation.commandId, key };
  }

  /**
   * Giden idempotency anahtarı.
   *
   * Deterministiktir: süreç çökse bile aynı işlem için aynı anahtar üretilir, yani
   * sağlayıcı mükerrer çağrıyı kendi tarafında da eler. `payment_commands` UNIQUE
   * ile birlikte iki katmanlı koruma sağlar.
   */
  private idempotencyKey(paymentId: string, operation: PaymentOperation, attempt: number): string {
    return createHash('sha256')
      .update(`${paymentId}:${operation}:${attempt}`, 'utf8')
      .digest('hex')
      .slice(0, 64);
  }

  /**
   * Giden çağrı hatasını kaydeder.
   *
   * **Kesin red ile belirsiz hata ayrılır** (Faz 5 review bulgusu C1):
   *
   * - `PaymentDeclinedError`: sağlayıcı işlemi reddetti, hiçbir şey işlemedi. Komut
   *   `FAILED` olur ve sonraki deneme yeni bir anahtar üretebilir.
   * - Timeout/erişilemez: çağrının sağlayıcıya **ulaşıp ulaşmadığı bilinmiyor**. Komut
   *   `PENDING` bırakılır; sonraki deneme aynı anahtarı yeniden kullanır ve sağlayıcı
   *   mükerrer çağrıyı kendi tarafında eler. `FAILED` işaretlemek, yeni anahtarla ikinci
   *   bir para hareketine kapı açardı.
   */
  private async recordCommandFailure(
    paymentId: string,
    commandId: string,
    error: unknown,
  ): Promise<void> {
    const resultCode =
      error instanceof PaymentDeclinedError
        ? error.declineCode
        : error instanceof PaymentProviderError
          ? error.code
          : 'UNKNOWN';

    if (!(error instanceof PaymentDeclinedError)) {
      // Sonuç belirsiz: satır PENDING kalır ve kiralama süresi dolunca aynı anahtarla
      // yeniden denenir. Mutabakat işi (Faz 11) bu satırları sağlayıcıya sorar.
      return;
    }

    await this.uow.withTransaction(async (client) => {
      await this.repository.completeCommand(client, {
        commandId,
        status: 'FAILED',
        resultCode,
      });

      // Reddedilen yetkilendirme ödemeyi `FAILED` yapar; böylece kısmi unique index
      // yeni bir deneme açmaya izin verir.
      const payment = await this.repository.findByIdLocked(client, paymentId);
      if (payment !== null && payment.status === 'CREATED') {
        await this.applyTransition(client, {
          payment,
          to: 'FAILED',
          source: 'COMMAND',
          failureCode: resultCode,
        });
      }
    });
  }

  private translateProviderError(error: unknown): unknown {
    if (error instanceof PaymentProviderUnavailableError) {
      return new BusinessException(ErrorCode.SERVICE_DEGRADED, {
        clientMessage: 'Ödeme servisine şu anda ulaşılamıyor, tekrar deneyin.',
      });
    }
    if (error instanceof PaymentDeclinedError) {
      return new BusinessException(ErrorCode.PAYMENT_DECLINED);
    }
    if (error instanceof PaymentProviderError) {
      return new BusinessException(ErrorCode.PAYMENT_FAILED);
    }
    return error;
  }

  /** Sağlayıcı olay tipi → ödeme durumu. Bilinmeyen tip uygulanmaz. */
  private statusForWebhook(type: string): PaymentStatus | null {
    switch (type) {
      case 'AUTHORIZED':
        return 'AUTHORIZED';
      case 'HELD':
        return 'HELD';
      case 'CAPTURED':
      case 'RELEASED':
        return 'RELEASED';
      case 'REFUNDED':
        return 'REFUNDED';
      case 'FAILED':
        return 'FAILED';
      case 'EXPIRED':
        return 'AUTHORIZATION_EXPIRED';
      case 'DISPUTE_OPENED':
        return 'DISPUTED';
      default:
        return null;
    }
  }
}
