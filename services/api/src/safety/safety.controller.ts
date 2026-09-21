import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/auth.decorators';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { ParticipantRateLimiter } from './participant-rate-limiter';
import {
  EvaluationResponseDto,
  OperatorLocationQueryDto,
  OperatorLocationsResponseDto,
  OperatorSessionDetailDto,
  OperatorSessionQueryDto,
  OperatorSessionSummaryDto,
  CloseSessionDto,
  OverrideRiskDto,
  PanicDto,
  PanicResponseDto,
  SafetySessionParticipantDto,
  TelemetryBatchDto,
  TelemetryIngestResponseDto,
} from './dto/safety.dto';
import { PanicService } from './panic.service';
import { SafetyEvaluationService } from './safety-evaluation.service';
import { SafetyOperatorService } from './safety-operator.service';
import { SafetyRepository } from './safety.repository';
import { TelemetryService } from './telemetry.service';

/**
 * Telemetri için kullanıcı başına, kimlik doğrulandıktan sonra uygulanan sınır (bkz.
 * ParticipantRateLimiter): 30 sn aralıkla beklenen ~2 istek/dk'nın çok üstünde;
 * tampon boşaltma ve yeniden denemeye yer bırakır.
 *
 * Panikte sınır **yoktur**: sıkıntıdaki birinin 21. basışı 429 almamalı. Tekrar ve
 * reddedilen basışlar kilitsiz döner (satır kilidi ya da yazma yok); kabul edilen
 * panik kişi ve bölüm başına tekildir.
 */
const TELEMETRY_PER_USER_PER_MINUTE = 60;

/** Operatör görünümünde döndürülen en fazla değerlendirme/olay/oturum. */
const OPERATOR_HISTORY_LIMIT = 100;
const OPERATOR_LIST_LIMIT = 200;

/**
 * Safety API (ADR-0019 §9).
 *
 * Yalnızca ürünün gerçekten ihtiyaç duyduğu uçlar vardır. Oturum **açma** ucu
 * yoktur: oturum rezervasyonun durumundan türer (SCHEDULED/PROVIDER_ARRIVING),
 * istemci "izlemeyi başlat" diyemez — deyebilseydi konum toplama amacından
 * koparılabilirdi. Check-in/check-out da mevcut booking geçiş ucundan geçer.
 */
@Controller()
export class SafetyController {
  constructor(
    private readonly repository: SafetyRepository,
    private readonly telemetry: TelemetryService,
    private readonly panic: PanicService,
    private readonly evaluation: SafetyEvaluationService,
    private readonly operator: SafetyOperatorService,
    private readonly limiter: ParticipantRateLimiter,
  ) {}

  private limit(key: string, limit: number): void {
    if (!this.limiter.consume(key, limit, 60)) {
      throw new BusinessException(ErrorCode.RATE_LIMITED, {
        details: { retryAfterSeconds: 60 },
      });
    }
  }

  /** Rezervasyonun güvenlik oturumu — yalnızca taraflara, dar görünüm. */
  @Get('bookings/:id/safety-session')
  async sessionForBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) bookingId: string,
  ): Promise<SafetySessionParticipantDto> {
    const session = await this.repository.findLatestForBookingParticipant(bookingId, user.id);
    if (session === null) {
      throw new BusinessException(ErrorCode.SAFETY_SESSION_NOT_FOUND);
    }
    // Etkin panik yalnızca onu başlatan kişiye gösterilir: tehdit altındaki
    // sağlayıcının paniğini tehdidin kaynağı olabilecek karşı tarafa bildirmek
    // tehlikeyi artırabilirdi (review bulgusu H2).
    const raisedByViewer = await this.repository.hasActivePanicBy(session.id, user.id);
    return SafetySessionParticipantDto.from(session, user.id, raisedByViewer);
  }

  /**
   * Konum telemetrisi — yalnızca oturumun sağlayıcısı.
   *
   * Global (IP, kimlik öncesi) oran sınırı **bilinçli olarak yok**: Cloud Run
   * arkasında tek bir IP kovası, kimliksiz bir saldırganın tüm sağlayıcıların
   * telemetrisini kesmesine izin verirdi (review bulgusu H1). Sınır kullanıcı
   * başınadır ve Redis'e bağlı değildir; kalıcı koruma oturum başına sıra numarası ve
   * asgari aralıktır (veritabanında, kilit altında).
   */
  @Post('safety/sessions/:id/telemetry')
  @HttpCode(HttpStatus.OK)
  async submitTelemetry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: TelemetryBatchDto,
  ): Promise<TelemetryIngestResponseDto> {
    this.limit(`telemetry:${user.id}`, TELEMETRY_PER_USER_PER_MINUTE);
    const result = await this.telemetry.ingest({
      sessionId,
      userId: user.id,
      samples: dto.samples.map((sample) => ({
        sequence: sample.sequence,
        capturedAt: sample.capturedAt,
        latitude: sample.latitude,
        longitude: sample.longitude,
        accuracyMeters: sample.accuracyMeters,
        speedMps: sample.speedMps ?? null,
        headingDegrees: sample.headingDegrees ?? null,
        isMockLocation: sample.isMockLocation ?? false,
      })),
    });
    return TelemetryIngestResponseDto.from(result);
  }

  /**
   * Panik — oturumun **iki tarafı** da basabilir.
   *
   * Bilinçli olarak oran sınırı **yoktur**: Redis'li guard fail-closed'dır ve
   * Redis kesintisi paniği bloklamamalı (ADR-0008 §3); süreç içi sınır ise sıkıntıdaki
   * kullanıcının tekrar basışını reddederdi. Spam koruması: aynı kişinin tekrarı ve
   * kabul edilmeyen durumlar kilitsiz ve yazmasız döner.
   */
  @Post('safety/sessions/:id/panic')
  @HttpCode(HttpStatus.CREATED)
  async raisePanic(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: PanicDto,
  ): Promise<PanicResponseDto> {
    const result = await this.panic.raise({
      sessionId,
      userId: user.id,
      category: dto.category ?? null,
    });
    return PanicResponseDto.from(result);
  }

  // --- Operatör ---

  /** Açık oturumlar. SUPPORT okur (ADR-0013 §4); koordinat içermez. */
  @Get('safety/operator/sessions')
  @Roles('ADMIN', 'SUPPORT')
  async listOpen(@Query() query: OperatorSessionQueryDto): Promise<OperatorSessionSummaryDto[]> {
    const sessions = await this.repository.listOpenForOperator(
      query.minRisk ?? 'NORMAL',
      OPERATOR_LIST_LIMIT,
    );
    return sessions.map((session) => OperatorSessionSummaryDto.from(session));
  }

  /** Oturum ayrıntısı: değerlendirmeler (kural bulguları, model sürümü) ve olaylar. */
  @Get('safety/operator/sessions/:id')
  @Roles('ADMIN', 'SUPPORT')
  async detail(@Param('id', ParseUUIDPipe) sessionId: string): Promise<OperatorSessionDetailDto> {
    const session = await this.repository.findById(sessionId);
    if (session === null) {
      throw new BusinessException(ErrorCode.SAFETY_SESSION_NOT_FOUND);
    }
    const [assessments, events] = await Promise.all([
      this.repository.listAssessments(sessionId, OPERATOR_HISTORY_LIMIT),
      this.repository.listEvents(sessionId, OPERATOR_HISTORY_LIMIT),
    ]);
    return OperatorSessionDetailDto.detail(session, assessments, events);
  }

  /** Ham konum izi — yalnızca ADMIN, her okuma audit'lenir. */
  @Get('safety/operator/sessions/:id/locations')
  @Roles('ADMIN')
  async locations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Query() query: OperatorLocationQueryDto,
  ): Promise<OperatorLocationsResponseDto> {
    const { session, locations } = await this.operator.readLocations({
      sessionId,
      actorUserId: user.id,
      limit: query.limit ?? 200,
      reason: query.reason,
      breakGlass: query.breakGlass === 'true',
    });
    return {
      sessionId: session.id,
      locationPurgedAt: session.locationPurgedAt?.toISOString() ?? null,
      locations: locations.map((location) => ({
        ...location,
        capturedAt: location.capturedAt.toISOString(),
        receivedAt: location.receivedAt.toISOString(),
      })),
    };
  }

  /** Operatörün risk kararı; EMERGENCY'den inmek etkin paniği çözer. */
  @Post('safety/operator/sessions/:id/risk')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async overrideRisk(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: OverrideRiskDto,
  ): Promise<OperatorSessionSummaryDto> {
    const session = await this.operator.overrideRisk({
      sessionId,
      actorUserId: user.id,
      riskLevel: dto.riskLevel,
      reason: dto.reason,
      floorMinutes: dto.floorMinutes ?? 120,
    });
    return OperatorSessionSummaryDto.from(session);
  }

  @Post('safety/operator/sessions/:id/close')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: CloseSessionDto,
  ): Promise<OperatorSessionSummaryDto> {
    const session = await this.operator.close({
      sessionId,
      actorUserId: user.id,
      reason: dto.reason,
    });
    return OperatorSessionSummaryDto.from(session);
  }

  /** Anında değerlendirme — operasyon ve Ar-Ge; izleyiciyi beklemeden. */
  @Post('safety/operator/sessions/:id/evaluate')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'safety-evaluate', limit: 30, windowSeconds: 60 })
  async evaluate(@Param('id', ParseUUIDPipe) sessionId: string): Promise<EvaluationResponseDto> {
    const result = await this.evaluation.evaluate(sessionId);
    if (result.status === 'NOT_FOUND') {
      throw new BusinessException(ErrorCode.SAFETY_SESSION_NOT_FOUND);
    }
    return EvaluationResponseDto.from(result);
  }
}
