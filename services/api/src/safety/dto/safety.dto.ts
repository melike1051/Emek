import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { AnomalyOutcome } from '../anomaly.port';
import type { EvaluationResult } from '../safety-evaluation.service';
import type { IngestResult } from '../telemetry.service';
import { PANIC_CATEGORIES, type PanicCategory, type PanicResult } from '../panic.service';
import { RISK_LEVELS, type RiskLevel } from '../safety.constants';
import type { AssessmentRecord, SafetyEventRecord, SafetySession } from '../safety.repository';
import { isPanicActive } from '../safety.repository';

/** Tek pakette en fazla örnek: cihaz uykusu sonrası tampon boşaltma için yeterli, flood için değil. */
export const MAX_SAMPLES_PER_BATCH = 20;

/**
 * Tek konum örneği.
 *
 * **Ne olmadığı** da sözleşmedir: istemci oturum durumu, geofence sonucu, risk
 * seviyesi, rezervasyon kimliği ya da "güvendeyim" bilgisi gönderemez — alanı
 * yoktur ve `forbidNonWhitelisted` bilinmeyen alanı reddeder. Bunların hepsi
 * sunucuda türetilir (ADR-0008 §7).
 */
export class TelemetrySampleDto {
  /** Oturum içinde kesin artan sıra numarası (replay koruması). */
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sequence!: number;

  /** Cihazın örneği aldığı an. **İddiadır**; sunucu saatine göre sınırlanır. */
  @Type(() => Date)
  @IsDate()
  capturedAt!: Date;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude!: number;

  /** Platformun bildirdiği yatay doğruluk (metre, 1σ). Kötü doğruluk reddedilmez, "belirsiz" sayılır. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100000)
  accuracyMeters!: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(400)
  speedMps?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(359.999)
  headingDegrees?: number;

  /** Platformun sahte konum işareti (Android `isMock`, iOS `isSimulatedBySoftware`). */
  @IsOptional()
  @IsBoolean()
  isMockLocation?: boolean;
}

export class TelemetryBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SAMPLES_PER_BATCH)
  @ValidateNested({ each: true })
  @Type(() => TelemetrySampleDto)
  samples!: TelemetrySampleDto[];
}

export class TelemetryIngestResponseDto {
  sessionId!: string;
  accepted!: number;
  rejected!: number;
  results!: { sequence: number; status: 'ACCEPTED' | 'REJECTED'; reason: string | null }[];
  telemetryIntervalSeconds!: number;

  static from(result: IngestResult): TelemetryIngestResponseDto {
    return {
      sessionId: result.sessionId,
      accepted: result.accepted,
      rejected: result.rejected,
      results: result.results,
      telemetryIntervalSeconds: result.telemetryIntervalSeconds,
    };
  }
}

export class PanicDto {
  @IsOptional()
  @IsIn(PANIC_CATEGORIES)
  category?: PanicCategory;
}

export class PanicResponseDto {
  sessionId!: string;
  eventId!: string;
  raisedAt!: string;
  duplicate!: boolean;
  bookingHoldApplied!: boolean;

  static from(result: PanicResult): PanicResponseDto {
    return {
      sessionId: result.sessionId,
      eventId: result.eventId,
      raisedAt: result.raisedAt.toISOString(),
      duplicate: result.duplicate,
      bookingHoldApplied: result.bookingHoldApplied,
    };
  }
}

/**
 * Rezervasyon tarafının gördüğü oturum.
 *
 * Kasıtlı olarak **dar**dır (ADR-0019 §9): risk seviyesi, tetiklenen kurallar,
 * anomali skoru, geofence durumu ve hizmet noktası koordinatı **yoktur**. İç risk
 * mantığını taraflara açmak hem oyunlaştırmaya (kuralı atlatmayı öğrenmek) hem de
 * "sistem beni şüpheli sayıyor" türünden haksız bir etiketlemeye yol açardı.
 * Taraf yalnızca şunu bilir: izleme açık mı, ne sıklıkla konum beklenir ve
 * **kendi** başlattığı acil durum kaydı etkin mi. Karşı tarafın paniği gösterilmez.
 */
export class SafetySessionParticipantDto {
  sessionId!: string;
  bookingId!: string;
  status!: string;
  acceptsTelemetry!: boolean;
  /** Yalnızca sağlayıcı konum gönderir; müşteri konumu toplanmaz. */
  telemetryExpectedFromYou!: boolean;
  telemetryIntervalSeconds!: number;
  lastSequence!: number;
  emergencyActive!: boolean;
  panicRaisedAt!: string | null;
  closedAt!: string | null;

  static from(
    session: SafetySession,
    viewerId: string,
    raisedByViewer: boolean,
  ): SafetySessionParticipantDto {
    const accepting = session.status === 'ARRIVAL_MONITORING' || session.status === 'ACTIVE';
    const isProvider = session.providerId === viewerId;
    return {
      sessionId: session.id,
      bookingId: session.bookingId,
      status: session.status,
      acceptsTelemetry: accepting,
      telemetryExpectedFromYou: accepting && isProvider,
      telemetryIntervalSeconds: session.telemetryIntervalSeconds,
      // Yalnızca sağlayıcıya anlamlı: uygulama yeniden başladığında sırayı buradan sürdürür.
      lastSequence: isProvider ? session.lastSequence : 0,
      // Yalnızca paniği başlatan kişi görür (bkz. controller).
      emergencyActive: raisedByViewer && isPanicActive(session),
      panicRaisedAt: raisedByViewer ? (session.panicRaisedAt?.toISOString() ?? null) : null,
      closedAt: session.closedAt?.toISOString() ?? null,
    };
  }
}

// --- Operatör ---

export class OperatorSessionQueryDto {
  @IsOptional()
  @IsIn(RISK_LEVELS)
  minRisk?: RiskLevel;
}

export class OperatorLocationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  /** Erişim amacı — zorunlu ve audit'e yazılır (amaçla sınırlılık). */
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;

  /**
   * "Cam kırma": risk `NORMAL` ve hiç panik olmamış bir oturumun ham izini okumak
   * için açık beyan. Audit'te ayrıca işaretlenir.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  breakGlass?: 'true' | 'false';
}

export class CloseSessionDto {
  /** Gerekçe zorunlu: gerekçesiz kapanış denetlenemez ve alarmı sessizce kapatabilirdi. */
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

export class OverrideRiskDto {
  @IsIn(RISK_LEVELS)
  riskLevel!: RiskLevel;

  /** Gerekçe zorunlu: gerekçesiz bir risk kararı denetlenemez. */
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;

  /**
   * Operatör kararının **taban** olarak geçerli kalacağı süre (dakika). Bu süre
   * boyunca otomatik değerlendirme seviyeyi bunun altına indiremez. `NORMAL`'de
   * yok sayılır (taban kalkar). Varsayılan 120.
   */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  floorMinutes?: number;
}

/** Operatör özeti — koordinat içermez; ham iz ayrı ve audit'li uçtadır. */
export class OperatorSessionSummaryDto {
  sessionId!: string;
  bookingId!: string;
  providerId!: string;
  customerId!: string;
  status!: string;
  riskLevel!: string;
  geofenceState!: string;
  lastDistanceMeters!: number | null;
  lastTelemetryAt!: string | null;
  telemetryCount!: number;
  rejectedCount!: number;
  integrityRejectionCount!: number;
  mockLocationCount!: number;
  activeRules!: string[];
  anomalyFlagged!: boolean;
  emergencyActive!: boolean;
  panicRaisedAt!: string | null;
  scheduledStart!: string;
  scheduledEnd!: string;
  closedAt!: string | null;
  closureReason!: string | null;
  retentionExpiresAt!: string;
  locationPurgedAt!: string | null;

  static from(session: SafetySession): OperatorSessionSummaryDto {
    return {
      sessionId: session.id,
      bookingId: session.bookingId,
      providerId: session.providerId,
      customerId: session.customerId,
      status: session.status,
      riskLevel: session.riskLevel,
      geofenceState: session.geofenceState,
      lastDistanceMeters: session.lastDistanceMeters,
      lastTelemetryAt: session.lastTelemetryAt?.toISOString() ?? null,
      telemetryCount: session.telemetryCount,
      rejectedCount: session.rejectedCount,
      integrityRejectionCount: session.integrityRejectionCount,
      mockLocationCount: session.mockLocationCount,
      activeRules: session.activeRules,
      anomalyFlagged: session.anomalyFlagged,
      emergencyActive: isPanicActive(session),
      panicRaisedAt: session.panicRaisedAt?.toISOString() ?? null,
      scheduledStart: session.scheduledStart.toISOString(),
      scheduledEnd: session.scheduledEnd.toISOString(),
      closedAt: session.closedAt?.toISOString() ?? null,
      closureReason: session.closureReason,
      retentionExpiresAt: session.retentionExpiresAt.toISOString(),
      locationPurgedAt: session.locationPurgedAt?.toISOString() ?? null,
    };
  }
}

export class OperatorSessionDetailDto extends OperatorSessionSummaryDto {
  assessments!: Record<string, unknown>[];
  events!: Record<string, unknown>[];

  static detail(
    session: SafetySession,
    assessments: AssessmentRecord[],
    events: SafetyEventRecord[],
  ): OperatorSessionDetailDto {
    return {
      ...OperatorSessionSummaryDto.from(session),
      assessments: assessments.map((assessment) => ({
        ...assessment,
        evaluatedAt: assessment.evaluatedAt.toISOString(),
      })),
      events: events.map((event) => ({
        ...event,
        occurredAt: event.occurredAt.toISOString(),
      })),
    };
  }
}

export class EvaluationResponseDto {
  status!: string;
  sessionId!: string;
  previousRiskLevel!: string | null;
  riskLevel!: string | null;
  computedRiskLevel!: string | null;
  findings!: { ruleId: string; ruleVersion: string; severity: string }[];
  anomaly!: {
    status: string;
    reason: string | null;
    score: number | null;
    modelVersion: string | null;
  };
  unavailableSignals!: string[];
  assessmentId!: string | null;
  latencyMs!: number;

  static from(result: EvaluationResult): EvaluationResponseDto {
    return {
      status: result.status,
      sessionId: result.sessionId,
      previousRiskLevel: result.previousRiskLevel,
      riskLevel: result.riskLevel,
      computedRiskLevel: result.computedRiskLevel,
      findings: result.findings.map((finding) => ({
        ruleId: finding.ruleId,
        ruleVersion: finding.ruleVersion,
        severity: finding.severity,
      })),
      anomaly: summarizeAnomaly(result.anomaly),
      unavailableSignals: result.unavailableSignals,
      assessmentId: result.assessmentId,
      latencyMs: result.latencyMs,
    };
  }
}

function summarizeAnomaly(outcome: AnomalyOutcome | null): EvaluationResponseDto['anomaly'] {
  if (outcome === null) {
    return { status: 'NOT_EVALUATED', reason: null, score: null, modelVersion: null };
  }
  if (outcome.status === 'UNAVAILABLE') {
    return { status: 'UNAVAILABLE', reason: outcome.reason, score: null, modelVersion: null };
  }
  return {
    status: 'ASSESSED',
    reason: null,
    score: outcome.assessment.anomalyScore,
    modelVersion: outcome.assessment.modelVersion,
  };
}

export class OperatorLocationsResponseDto {
  sessionId!: string;
  locationPurgedAt!: string | null;
  locations!: {
    sequence: number;
    capturedAt: string;
    receivedAt: string;
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    isMockLocation: boolean;
    distanceMeters: number;
    geofenceState: string;
  }[];
}
