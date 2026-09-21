import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/auth.decorators';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { BookingRequestsService } from '../requests/booking-requests.service';
import { MatchBatchDto, MatchResultResponseDto, MatchRunResponseDto } from './dto/matching.dto';
import { MatchingRepository } from './matching.repository';
import { MatchingService } from './matching.service';

@Controller()
export class MatchingController {
  constructor(
    private readonly matching: MatchingService,
    private readonly repository: MatchingRepository,
    private readonly requests: BookingRequestsService,
  ) {}

  /**
   * Talebi eşleştirir.
   *
   * Sahiplik zorunludur: eşleştirme sağlayıcı ataması ve rezervasyon oluşturur —
   * başkasının talebi için tetiklenebilseydi, üçüncü bir kullanıcı başka birinin
   * adına randevu oluşturabilirdi.
   *
   * Oran sınırı düşük tutulur: her çağrı bir aday havuzu sorgusu ve bir
   * optimizasyon çalıştırması demektir (abuse yüzeyi).
   */
  @Post('booking-requests/:id/match')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'matching-run', limit: 10, windowSeconds: 60 })
  async match(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MatchResultResponseDto> {
    await this.assertOwnedRequest(id, user.id);

    const outcome = await this.matching.matchRequest({ requestId: id, actorUserId: user.id });
    return MatchResultResponseDto.from(outcome);
  }

  /**
   * Müşterinin eşleştirme sonucunu okuması.
   *
   * Yalnızca **seçilen** sağlayıcı döner. Tam sıralama operasyon uçundadır:
   * değerlendirilen adayların listesi, o sağlayıcıların müsaitliğini ve konumunu
   * müşteriye sızdırırdı (T-19).
   */
  @Get('booking-requests/:id/match')
  async result(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MatchResultResponseDto> {
    await this.assertOwnedRequest(id, user.id);

    const run = await this.repository.findLatestRun(id);
    if (run === null) {
      throw new BusinessException(ErrorCode.MATCHING_RUN_NOT_FOUND);
    }

    const results = await this.repository.findResults(run.runId);
    const selected = results.find((result) => result.selected);

    return {
      requestId: id,
      runId: run.runId,
      status: selected === undefined ? 'NO_CANDIDATE' : 'MATCHED',
      degraded: run.degradedReason !== null,
      // Karar kaydı rezervasyon kimliğini taşımaz; talep üzerinden okunur.
      bookingId: await this.repository.findBookingIdForRequest(id),
      providerId: selected?.providerId ?? null,
      providerName:
        selected === undefined
          ? null
          : await this.repository.findProviderDisplayName(selected.providerId),
      scheduledStart: selected?.proposedStart?.toISOString() ?? null,
      scheduledEnd: selected?.proposedEnd?.toISOString() ?? null,
      explanation: selected?.explanation ?? [],
    };
  }

  /**
   * Toplu (küresel) eşleştirme — operasyon.
   *
   * Kapasite ve seyahat kısıtları nedeniyle talepleri **birlikte** çözmek, tek tek
   * çözmekten farklı ve daha iyi bir sonuç üretir; bu uç o yolu açar.
   * `ADMIN` ile sınırlıdır: başkalarının talepleri adına rezervasyon oluşturur.
   */
  @Post('matching/runs')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'matching-batch', limit: 5, windowSeconds: 60 })
  async batch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MatchBatchDto,
  ): Promise<MatchResultResponseDto[]> {
    const outcomes = await this.matching.match(dto.requestIds, user.id);
    return outcomes.map(MatchResultResponseDto.from);
  }

  /**
   * Bir çalıştırmanın tam sonucu — operasyon ve Ar-Ge.
   *
   * Skor bileşenleri yalnızca burada görünür. `ADMIN` dışına açılsaydı hem sıralama
   * oyunlaştırılabilir hâle gelir hem de değerlendirilen sağlayıcıların verisi
   * karşılaştırmalı olarak sızardı.
   */
  @Get('matching/runs/:requestId')
  @Roles('ADMIN')
  async run(@Param('requestId', ParseUUIDPipe) requestId: string): Promise<MatchRunResponseDto> {
    const run = await this.repository.findLatestRun(requestId);
    if (run === null) {
      throw new BusinessException(ErrorCode.MATCHING_RUN_NOT_FOUND);
    }

    const results = await this.repository.findResults(run.runId);

    return {
      runId: run.runId,
      requestId,
      algorithmVersion: run.algorithmVersion,
      weightsVersion: run.weightsVersion,
      objectiveVersion: run.objectiveVersion,
      strategy: run.strategy,
      degradedReason: run.degradedReason,
      candidateCount: run.candidateCount,
      eligibleCount: run.eligibleCount,
      createdAt: run.createdAt.toISOString(),
      candidates: results.map((result) => ({
        providerId: result.providerId,
        rank: result.rank,
        overallScore: result.overallScore,
        components: result.components,
        selected: result.selected,
        distanceMeters: result.distanceMeters,
        travelSeconds: result.travelSeconds,
        proposedStart: result.proposedStart?.toISOString() ?? null,
        proposedEnd: result.proposedEnd?.toISOString() ?? null,
        explanation: result.explanation,
      })),
    };
  }

  /** Talebin sahibi değilse varlığı bile bildirilmez. */
  private async assertOwnedRequest(requestId: string, userId: string): Promise<void> {
    const request = await this.requests.findOwned(requestId, userId);
    if (request === null) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }
  }
}
