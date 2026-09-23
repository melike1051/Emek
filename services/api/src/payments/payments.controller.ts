import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, Public, Roles, type AuthenticatedUser } from '../auth/auth.decorators';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { clampLimit, decodeCursor, paginate } from '../common/pagination/cursor';
import { SkipAppCheck } from '../common/appcheck/app-check.decorators';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { UserRateLimit } from '../common/ratelimit/user-rate-limit.decorator';
import {
  AdminPaymentListResponseDto,
  AdminPaymentQueryDto,
  PaymentIntentResponseDto,
  PaymentResponseDto,
  PaymentWebhookResponseDto,
  RefundPaymentDto,
} from './dto/payment.dto';
import { PaymentsService } from './payments.service';

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Rezervasyon için ödeme yetkilendirmesi alır.
   *
   * Yalnızca müşteri çağırır (sahiplik serviste sorgunun içinde). Idempotency
   * `Idempotency-Key` başlığıyla da desteklenir (global interceptor); ayrıca
   * `payment_commands` giden çağrıyı ikinci kez göndermez.
   */
  @Post('bookings/:id/payment')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'payment-authorize', limit: 10, windowSeconds: 60 })
  @UserRateLimit({ name: 'payment-authorize', limit: 10, windowSeconds: 300 })
  async authorize(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaymentIntentResponseDto> {
    const intent = await this.payments.authorizeForBooking({ bookingId: id, userId: user.id });
    return PaymentIntentResponseDto.from(intent);
  }

  @Get('bookings/:id/payment')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaymentResponseDto> {
    const payment = await this.payments.findForBooking(id, user.id);
    if (payment === null) {
      // Taraf olmayan kullanıcıya ödemenin varlığı bildirilmez.
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }
    return PaymentResponseDto.from(payment);
  }

  /** Admin izleme listesi. Sahiplik kapısı yoktur — bkz. `PaymentsRepository.listForAdmin`. */
  @Get('payments/admin')
  @Roles('ADMIN', 'SUPPORT')
  async adminList(@Query() query: AdminPaymentQueryDto): Promise<AdminPaymentListResponseDto> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.payments.listForAdmin({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.bookingId !== undefined ? { bookingId: query.bookingId } : {}),
      limit: limit + 1,
      ...(cursor !== null ? { before: cursor } : {}),
    });
    const page = paginate(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
    return { items: page.items.map(PaymentResponseDto.from), nextCursor: page.nextCursor };
  }

  /**
   * Ödemeyi serbest bırakır.
   *
   * **Operatör aksiyonudur.** Müşteri onayı veya "hizmet tamamlandı" bilgisi tek başına
   * parayı çıkarmaz: uyuşmazlık penceresi ve güvenlik kontrolleri araya girer. Otomatik
   * release Faz 9'da zamanlanmış iş olarak, aynı guard'ların arkasında bağlanacak.
   */
  @Post('payments/:id/release')
  @Roles('ADMIN')
  async release(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaymentResponseDto> {
    const payment = await this.payments.release({ paymentId: id, actorUserId: user.id });
    return PaymentResponseDto.from(payment);
  }

  /** İade de operatör kararıdır: taraflar kendi başına para geri çekemez. */
  @Post('payments/:id/refund')
  @Roles('ADMIN')
  async refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundPaymentDto,
  ): Promise<PaymentResponseDto> {
    const payment = await this.payments.refund({
      paymentId: id,
      ...(dto.amountMinor !== undefined ? { amountMinor: dto.amountMinor } : {}),
      actorUserId: user.id,
      reason: dto.reason,
    });
    return PaymentResponseDto.from(payment);
  }

  /** Süresi yaklaşan yetkilendirmeyi yeniler (operatör/zamanlanmış iş — ADR-0009 §4). */
  @Post('payments/:id/reauthorize')
  @Roles('ADMIN')
  async reauthorize(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentResponseDto> {
    const payment = await this.payments.reauthorize(id);
    return PaymentResponseDto.from(payment);
  }

  /**
   * Sağlayıcı webhook'u.
   *
   * `@Public()`: çağıran sağlayıcıdır, Emek oturumu yoktur. Kimlik doğrulaması yerine
   * **imza** geçerlidir ve imza adapter içinde doğrulanır (ADR-0009 §7). Ham gövde
   * imzalandığı için `rawBody` kullanılır — JSON yeniden serileştirmek imzayı bozar.
   *
   * Yanıt her zaman 200'dür (imza geçerliyse): sağlayıcıya "işlendi mi" ayrıntısı
   * verilmez, aksi halde hangi ödemelerin var olduğu sızardı. Duplicate event de
   * 200 döner ve yan etki üretmez (T-09).
   */
  @Post('payments/webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Çağıran ödeme kuruluşudur; mobil uygulama yoktur. Doğrulama modeli imzadır.
  @SkipAppCheck()
  @RateLimit({ name: 'payment-webhook', limit: 300, windowSeconds: 60 })
  async webhook(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('x-signature') signature: string | undefined,
  ): Promise<PaymentWebhookResponseDto> {
    const rawBody = request.rawBody?.toString('utf8');
    if (rawBody === undefined || rawBody.length === 0) {
      throw new BusinessException(ErrorCode.PAYMENT_WEBHOOK_REJECTED);
    }

    await this.payments.handleWebhook(rawBody, signature);
    return { received: true };
  }
}
