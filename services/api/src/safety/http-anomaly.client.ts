import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppConfigService } from '../common/config/app-config.service';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import type {
  AnomalyAssessment,
  AnomalyClient,
  AnomalyContribution,
  AnomalyFeatures,
  AnomalyOutcome,
  RouteEstimate,
} from './anomaly.port';

/**
 * AI servisine HTTP ile bağlanan anomali istemcisi.
 *
 * `HttpNlpClient` ve `HttpMatchingClient` ile aynı üç ilke — ama burada dördüncü
 * bir ilke daha var ve en önemlisi odur: **güvenlik akışı bu istemcinin
 * başarısına bağlı değildir.** Model erişilemezse değerlendirme deterministik
 * kurallarla tamamlanır; panik zaten bu yolu hiç kullanmaz.
 *
 * Timeout bilinçli olarak **kısadır**: anomali skoru, güvenlik kararını
 * geciktirmeye değecek bir girdi değildir.
 */
@Injectable()
export class HttpAnomalyClient implements AnomalyClient {
  constructor(
    private readonly config: AppConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async assess(features: AnomalyFeatures): Promise<AnomalyOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.env.SAFETY_ANOMALY_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.config.env.AI_SERVICE_URL}/api/v1/safety/anomaly`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.env.AI_SERVICE_API_KEY !== undefined
            ? { 'x-service-key': this.config.env.AI_SERVICE_API_KEY }
            : {}),
        },
        body: JSON.stringify(toWire(features)),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          // Model isteği **anlamadı**: şemalar ayrışmış. Kesinti değil, hata.
          this.logger.error(
            { status: response.status },
            'anomali servisi isteği reddetti: sözleşme uyuşmazlığı',
          );
          return { status: 'UNAVAILABLE', reason: 'CONTRACT_MISMATCH' };
        }
        this.logger.warn({ status: response.status }, 'anomali servisi hata döndürdü');
        return { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
      }

      // Gövde JSON değilse bu bir taşıma hatası değil, bozuk yanıttır: ayrı
      // raporlanır ki "servis kapalı" ile "servis saçmalıyor" karışmasın.
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) {
          throw new Error('timeout');
        }
        this.logger.warn('anomali servisi JSON olmayan yanıt döndürdü');
        return { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
      }

      const assessment = toAssessment(payload);
      if (assessment === null) {
        this.logger.warn('anomali servisi şemaya uymayan yanıt döndürdü');
        return { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
      }
      return { status: 'ASSESSED', assessment };
    } catch (error) {
      const reason = controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT';
      // Koordinat ve oturum içeriği loglanmaz: konum S1 kişisel veridir.
      this.logger.warn({ reason }, 'anomali servisine ulaşılamadı');
      void error;
      return { status: 'UNAVAILABLE', reason };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function toWire(features: AnomalyFeatures): Record<string, unknown> {
  return {
    session_status: features.sessionStatus,
    telemetry_interval_seconds: features.telemetryIntervalSeconds,
    planned_duration_seconds: features.plannedDurationSeconds,
    arrival_delay_seconds: features.arrivalDelaySeconds,
    elapsed_active_seconds: features.elapsedActiveSeconds,
    geofence_state: features.geofenceState,
    geofence_state_seconds: features.geofenceStateSeconds,
    seconds_since_telemetry: features.secondsSinceTelemetry,
    telemetry_count: features.telemetryCount,
    rejected_count: features.rejectedCount,
    integrity_rejection_count: features.integrityRejectionCount,
    mock_location_count: features.mockLocationCount,
    last_distance_meters: features.lastDistanceMeters,
    recent_movement_meters: features.recentMovementMeters,
    recent_window_seconds: features.recentWindowSeconds,
    distance_trend_meters: features.distanceTrendMeters,
    recent_long_gap_count: features.recentLongGapCount,
    recent_exit_count: features.recentExitCount,
    route: features.route,
  };
}

/**
 * Yanıtı yeniden doğrular. Skor, kalite ve sürüm zorunludur; biri bozuksa **tüm**
 * yanıt reddedilir (`INVALID_RESPONSE`). Katkılar ve rota ise isteğe bağlı yan
 * ürünlerdir: bozuk bir katkı satırı düşer, bozuk bir rota "rota yok" sayılır —
 * ama asla bozuk hâliyle kullanılmaz.
 */
export function toAssessment(payload: unknown): AnomalyAssessment | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const body = payload as Record<string, unknown>;

  const score = readUnit(body.anomaly_score);
  const quality = readUnit(body.quality);
  const modelVersion = body.model_version;

  if (
    score === null ||
    quality === null ||
    typeof modelVersion !== 'string' ||
    modelVersion.length === 0 ||
    modelVersion.length > 64
  ) {
    // Sürümsüz veya aralık dışı bir skor saklanamaz: `safety_risk_assessments`
    // CHECK'leri bunu zaten reddeder; değerlendirme çalışma zamanında patlamasın
    // diye burada elenir (ADR-0012 §1).
    return null;
  }

  return {
    anomalyScore: score,
    modelVersion,
    quality,
    contributions: toContributions(body.contributions),
    unavailableFeatures: toStringList(body.unavailable_features),
    route: toRoute(body.route),
  };
}

function readUnit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  return value;
}

function readNonNegativeInt(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    return null;
  }
  return Math.round(value);
}

function toRoute(value: unknown): RouteEstimate | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (entry.available !== true) {
    return null;
  }
  // Üst sınırlar: 24 saatten uzun ya da 1000 km'den uzak bir "varış" tahmini
  // güvenlik kararına girecek bir değer değildir; bozuk yanıt sayılır.
  const eta = readNonNegativeInt(entry.eta_seconds, 24 * 3600);
  const distance = readNonNegativeInt(entry.distance_meters, 1_000_000);
  const provider = entry.provider;
  if (
    eta === null ||
    distance === null ||
    typeof provider !== 'string' ||
    provider.length === 0 ||
    provider.length > 32
  ) {
    return null;
  }
  return { etaSeconds: eta, distanceMeters: distance, provider };
}

function toContributions(value: unknown): AnomalyContribution[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 32).flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }
    const entry = item as Record<string, unknown>;
    const contribution = readUnit(entry.contribution);
    if (
      typeof entry.feature !== 'string' ||
      entry.feature.length === 0 ||
      entry.feature.length > 64 ||
      contribution === null
    ) {
      return [];
    }
    return [{ feature: entry.feature, contribution }];
  });
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, 32)
    .filter(
      (item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 64,
    );
}
