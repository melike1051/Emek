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
  ApproveRecoveryDto,
  IdentityStatusResponseDto,
  RecoveryDecisionResponseDto,
  RecoveryQueueQueryDto,
  RecoveryQueueResponseDto,
  RecoveryRequestResponseDto,
  RejectRecoveryDto,
  StartVerificationDto,
  StartVerificationResponseDto,
  VerificationAttemptResponseDto,
  VerificationCallbackResponseDto,
} from './dto/identity.dto';
import { IdentityService } from './identity.service';

@Controller('verification')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  /**
   * Doğrulama oturumu başlatır.
   *
   * Oran sınırı iki katmanlıdır: buradaki IP bazlı guard ile kaba abuse, servis
   * içindeki kullanıcı bazlı deneme sayacı ile hedefli deneme seli engellenir (T-02).
   */
  @Post('session')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'verification-session', limit: 10, windowSeconds: 60 })
  @UserRateLimit({ name: 'verification-session', limit: 5, windowSeconds: 3600 })
  async startSession(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StartVerificationDto,
    @Req() request: Request,
  ): Promise<StartVerificationResponseDto> {
    const started = await this.identity.startSession({
      userId: user.id,
      method: dto.method,
      purpose: dto.purpose ?? 'ACCOUNT_VERIFICATION',
      ...(request.ip !== undefined ? { ipAddress: request.ip } : {}),
    });

    return {
      attemptId: started.attemptId,
      clientToken: started.clientToken,
      expiresAt: started.expiresAt.toISOString(),
      method: started.method,
      purpose: started.purpose,
    };
  }

  @Get('session/:id')
  async session(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VerificationAttemptResponseDto> {
    // Sorgu sahiplikle kapsanır: başka kullanıcının oturumu bulunamaz.
    const attempt = await this.identity.getAttempt(id, user.id);
    if (attempt === null) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }

    return {
      id: attempt.id,
      status: attempt.status,
      purpose: attempt.purpose,
      method: attempt.method,
      resultCode: attempt.resultCode,
      assuranceLevel: attempt.assuranceLevel,
      createdAt: attempt.createdAt.toISOString(),
      expiresAt: attempt.expiresAt.toISOString(),
      completedAt: attempt.completedAt === null ? null : attempt.completedAt.toISOString(),
    };
  }

  /**
   * Sağlayıcı callback'i.
   *
   * `@Public()`: çağıran sağlayıcıdır, Emek oturumu yoktur. Kimlik doğrulaması yerine
   * **imza** geçerlidir ve imza adapter içinde doğrulanır (ADR-0005). Ham gövde
   * imzalandığı için burada `rawBody` kullanılır — JSON yeniden serileştirmek imzayı bozar.
   */
  @Post('callback')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Çağıran kimlik sağlayıcısıdır; mobil uygulama yoktur. Doğrulama modeli imzadır.
  @SkipAppCheck()
  @RateLimit({ name: 'verification-callback', limit: 120, windowSeconds: 60 })
  async callback(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('x-signature') signature: string | undefined,
  ): Promise<VerificationCallbackResponseDto> {
    const rawBody = request.rawBody?.toString('utf8');
    if (rawBody === undefined || rawBody.length === 0) {
      throw new BusinessException(ErrorCode.VERIFICATION_FAILED);
    }

    const outcome = await this.identity.handleCallback(rawBody, signature);
    // Sağlayıcıya yalnızca sonuç bildirilir; kullanıcı kimliği dışarı verilmez.
    return { status: outcome.status };
  }

  @Get('status')
  async status(@CurrentUser() user: AuthenticatedUser): Promise<IdentityStatusResponseDto> {
    const status = await this.identity.statusFor(user.id);

    return {
      level: status.level,
      identityVerified: status.identityVerified,
      assuranceLevel: status.record?.assuranceLevel ?? null,
      verifiedAt: status.record?.verifiedAt?.toISOString() ?? null,
      provider: status.record?.verificationProvider ?? null,
    };
  }

  // --- Admin: hesap kurtarma kuyruğu (Faz 10) ---

  /**
   * Kurtarma kuyruğu. SUPPORT okuyabilir (triyaj), yalnızca ADMIN karar verebilir
   * (ADR-0013 §4 — safety operatör uçlarıyla aynı okuma/karar ayrımı).
   */
  @Get('recovery-requests')
  @Roles('ADMIN', 'SUPPORT')
  async recoveryQueue(@Query() query: RecoveryQueueQueryDto): Promise<RecoveryQueueResponseDto> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.identity.listRecoveryQueue({
      status: query.status ?? 'PENDING_REVIEW',
      limit: limit + 1,
      ...(cursor !== null ? { before: cursor } : {}),
    });
    const page = paginate(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
    return {
      items: page.items.map(RecoveryRequestResponseDto.from),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Onay: oturum kimliğini kanonik hesaba taşır. Devralma senaryosu nedeniyle
   * (bkz. `IdentityService.approveRecovery`) **yalnızca** operatör tetikleyebilir.
   */
  @Post('recovery-requests/:id/approve')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async approveRecovery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveRecoveryDto,
  ): Promise<RecoveryDecisionResponseDto> {
    const result = await this.identity.approveRecovery({
      requestId: id,
      actorUserId: user.id,
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
    });
    return { recoveredUserId: result.recoveredUserId, status: 'APPROVED' };
  }

  @Post('recovery-requests/:id/reject')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async rejectRecovery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectRecoveryDto,
  ): Promise<RecoveryDecisionResponseDto> {
    await this.identity.rejectRecovery({
      requestId: id,
      actorUserId: user.id,
      reason: dto.reason,
    });
    return { status: 'REJECTED' };
  }
}
