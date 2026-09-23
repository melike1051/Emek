import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { CursorQueryDto } from '../../common/pagination/cursor-query.dto';
import type { Payment } from '../payments.repository';
import type { PaymentIntentView } from '../payments.service';
import { PAYMENT_STATUSES, type PaymentStatus } from '../state/payment-status';

/**
 * Ödeme başlatma gövdesi **boştur**: tutar rezervasyondan okunur.
 *
 * İstemci tutar gönderebilse, anlaşmalı bir müşteri-sağlayıcı çifti keyfî düşük bir
 * tutarla komisyonu düşürebilirdi (Faz 4'teki fiyat bulgusunun ödeme karşılığı).
 * Kart verisi de burada yoktur ve olamaz: ödeme sayfası sağlayıcıya aittir.
 */
export class AuthorizePaymentDto {}

export class RefundPaymentDto {
  /**
   * Verilmezse kalan tutarın tamamı iade edilir.
   *
   * Para her yerde minor unit **string** olarak taşınır: JSON sayısı olarak alınsaydı
   * ayrıştırma aşamasında hassasiyet kaybı mümkün olurdu ve sistemin geri kalanıyla
   * (BIGINT → string) tutarsız olurdu (Faz 5 review bulgusu M2).
   */
  @IsOptional()
  @Matches(/^[1-9][0-9]{0,18}$/, { message: 'amountMinor pozitif bir tam sayı metni olmalı' })
  amountMinor?: string;

  @IsString()
  @MaxLength(160)
  reason!: string;
}

export class PaymentResponseDto {
  id!: string;
  bookingId!: string;
  amountMinor!: string;
  currency!: string;
  refundedMinor!: string;
  status!: string;
  authorizationExpiresAt!: string | null;
  releasedAt!: string | null;

  static from(payment: Payment): PaymentResponseDto {
    return {
      id: payment.id,
      bookingId: payment.bookingId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      refundedMinor: payment.refundedMinor,
      status: payment.status,
      authorizationExpiresAt: payment.authorizationExpiresAt?.toISOString() ?? null,
      releasedAt: payment.releasedAt?.toISOString() ?? null,
      // `external_payment_id` istemciye verilmez: sağlayıcı referansı iç bir detaydır.
    };
  }
}

export class PaymentIntentResponseDto {
  paymentId!: string;
  clientToken!: string;
  amountMinor!: string;
  currency!: string;
  status!: string;
  expiresAt!: string;

  static from(intent: PaymentIntentView): PaymentIntentResponseDto {
    return {
      paymentId: intent.paymentId,
      clientToken: intent.clientToken,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      status: intent.status,
      expiresAt: intent.expiresAt.toISOString(),
    };
  }
}

/** Webhook yanıtı: sağlayıcıya yalnızca "alındı" bilgisi döner. */
export class PaymentWebhookResponseDto {
  received!: boolean;
}

// --- Admin: ödeme izleme (Faz 10) ---

export class AdminPaymentQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  status?: PaymentStatus;

  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

export class AdminPaymentListResponseDto {
  items!: PaymentResponseDto[];
  nextCursor!: string | null;
}
