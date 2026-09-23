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

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 30_000;

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

  /**
   * Basit devre kesici. Servis düştüğünde her değerlendirme 1,5 sn zaman aşımı
   * bekleseydi, izleyici turu oturum sayısıyla doğrusal uzar ve telemetri kesintisi
   * gibi kurallar gecikirdi (Faz 8 review). Art arda altyapı hatasından sonra bir
   * süre çağrı yapılmaz; süre dolunca **tek** bir deneme yapılır (yarı açık).
   * Sözleşme hataları (4xx) devreyi açmaz: onlar kesinti değil, hatadır.
   *
   * Yarı-açıklık gerçek olmak zorundadır (Faz 14 code review): pencere dolduğunda
   * kapı serbest bırakılsaydı, izleyici turundaki tüm oturumlar aynı anda geçer ve
   * her biri tam zaman aşımını öderdi — kesici, maliyeti kaldırmak yerine 30
   * saniyede bir tekrarlayan bir sele çevirirdi. Bu yüzden deneme yapılmadan
   * **önce** pencere ileri atılır.
   */
  private consecutiveFailures = 0;
  private openUntil = 0;

  async assess(features: AnomalyFeatures, now: number = Date.now()): Promise<AnomalyOutcome> {
    if (now < this.openUntil) {
      return { status: 'UNAVAILABLE', reason: 'CIRCUIT_OPEN' };
    }

    const isProbe = this.openUntil > 0;
    if (isProbe) {
      this.openUntil = now + CIRCUIT_OPEN_MS;
    }

    const outcome = await this.call(features);

    const infrastructureFailure =
      outcome.status === 'UNAVAILABLE' &&
      (outcome.reason === 'TIMEOUT' ||
        outcome.reason === 'TRANSPORT' ||
        outcome.reason === 'SERVER_ERROR');

    if (!infrastructureFailure) {
      this.consecutiveFailures = 0;
      this.openUntil = 0;
      return outcome;
    }

    if (isProbe) {
      return outcome;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.openUntil = now + CIRCUIT_OPEN_MS;
      this.consecutiveFailures = 0;
      this.logger.warn({ openMs: CIRCUIT_OPEN_MS }, 'anomali servisi devre kesicisi açıldı');
    }

    return outcome;
  }

  private async call(features: AnomalyFeatures): Promise<AnomalyOutcome> {
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
        // 408 ve 429 işletme durumudur (yavaşlık/yük), sözleşme hatası değil: onları
        // CONTRACT_MISMATCH saymak, geçici bir yükü "şemalar ayrıştı" alarmına çevirirdi.
        if (response.status === 408) {
          this.logger.warn({ status: response.status }, 'anomali servisi zaman aşımı bildirdi');
          return { status: 'UNAVAILABLE', reason: 'TIMEOUT' };
        }
        if (response.status === 429) {
          this.logger.warn({ status: response.status }, 'anomali servisi isteği sınırladı');
          return { status: 'UNAVAILABLE', reason: 'TRANSPORT' };
        }
        if (response.status >= 400 && response.status < 500) {
          // Model isteği **anlamadı** (şemalar ayrışmış) ya da servis anahtarı yanlış
          // (401/403): kesinti değil, yapılandırma/sözleşme hatası.
          this.logger.error(
            { status: response.status },
            'anomali servisi isteği reddetti: sözleşme veya yapılandırma hatası',
          );
          return { status: 'UNAVAILABLE', reason: 'CONTRACT_MISMATCH' };
        }
        this.logger.warn({ status: response.status }, 'anomali servisi hata döndürdü');
        return { status: 'UNAVAILABLE', reason: 'SERVER_ERROR' };
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

/**
 * AI şemasının sayaç tavanı. Sayaçlar kırpılır: kendi oturumunda sayacı şişiren bir
 * istemci (ör. sürekli geleceğe tarihli örnek), aksi hâlde model isteğini 422'ye
 * düşürüp o oturumda anomali skorunu kalıcı olarak kapatabilirdi (review bulgusu L2).
 */
const WIRE_COUNT_CAP = 1_000_000;

function cap(value: number): number {
  return Math.min(Math.max(0, value), WIRE_COUNT_CAP);
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
    telemetry_count: cap(features.telemetryCount),
    rejected_count: cap(features.rejectedCount),
    integrity_rejection_count: cap(features.integrityRejectionCount),
    mock_location_count: cap(features.mockLocationCount),
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
