import { haversineMeters } from '../geo';
import { hysteresisMeters } from '../geofence';
import type { GeofenceState, RiskLevel, SafetySessionStatus } from '../safety.constants';

/**
 * Normalize edilmiş güvenlik sinyalleri.
 *
 * Kural motoru ve anomali modeli **aynı** doğrulanmış girdiyi tüketir. İkisi ayrı
 * girdiden beslenseydi, "kural ne gördü, model ne gördü" sorusu yanıtlanamaz ve
 * bir uyuşmazlıkta iki farklı gerçek ortaya çıkardı.
 *
 * Her sinyal **beklenen ile gözlenen** ayrımını açık tutar: "gecikti" demek yerine
 * "beklenen 14:00, gözlenen 14:35" denir. Yorum kuralın işidir, sinyalin değil.
 *
 * `null` bir değer "sinyal **yok**" demektir ve "normal" demek **değildir**.
 * Eksik sinyaller ayrıca `unavailable` listesine yazılır ve değerlendirme kaydına
 * geçer (ADR-0008 §2). Ham koordinat bu yapıda **yoktur**: sinyaller değerlendirme
 * kaydına (`safety_risk_assessments.signals`) yazılır ve o kayıt retention'dan
 * sonra da kalır.
 */
export interface SafetySignals {
  sessionStatus: SafetySessionStatus;
  evaluatedAt: Date;

  // --- Beklenen davranış ---
  scheduledStart: Date;
  scheduledEnd: Date;
  telemetryIntervalSeconds: number;
  geofenceRadiusMeters: number;

  // --- Gözlenen yaşam döngüsü ---
  monitoringStartedAt: Date | null;
  /** Oturumun `ACTIVE` olduğu an (check-in); hizmet süresi buradan ölçülür. */
  activatedAt: Date | null;
  /** Check-in anındaki kabul edilmiş geofence durumu. */
  activationGeofenceState: GeofenceState | null;

  // --- Geofence ---
  geofenceState: GeofenceState;
  geofenceStateSeconds: number | null;
  lastDistanceMeters: number | null;

  // --- Telemetri akışı ---
  /**
   * Son kabul edilen telemetriden bu yana geçen süre. Hiç telemetri gelmediyse
   * **izlemenin başladığı andan** itibaren ölçülür: "hiç veri yok" durumu
   * sessizce normal sayılmaz.
   */
  secondsSinceTelemetry: number | null;
  telemetryCount: number;
  rejectedCount: number;
  integrityRejectionCount: number;
  mockLocationCount: number;

  // --- İz özeti (son pencere) ---
  recentMovementMeters: number | null;
  recentWindowSeconds: number | null;
  recentSampleCount: number;
  /** Pencere içinde hizmet noktasına mesafedeki değişim; pozitif = uzaklaşıyor. */
  distanceTrendMeters: number | null;
  /**
   * Oturum geçmişi (son pencere): 5 dakikayı aşan örnek boşlukları ve içeriden
   * dışarıya kesin çıkış sayısı. Tek başına her biri olağandır; **tekrarları**
   * anlık değerlendirmenin göremediği bir tablo oluşturur (EXP-004 bulgusu).
   */
  recentLongGapCount: number | null;
  recentExitCount: number | null;
  /**
   * Son **kesin** geofence gözleminin yaşı ve yönü (pencere içinde).
   *
   * Debounce edilmiş durum "son kalıcı kesin durum"dur; kapalı alanda GPS kesin
   * gözlem üretmeyi bırakınca durum eskir ama değişmez. Kanıtın tazeliği olmadan
   * "hâlâ dışarıda" demek, bina içine girmiş sağlayıcıyı dışarıda sayardı
   * (EXP-004 geliştirme bulgusu).
   */
  geofenceEvidenceAgeSeconds: number | null;
  geofenceEvidenceSide: 'INSIDE' | 'OUTSIDE' | null;

  // --- Rota (altyapı; Faz 7 routing portu, AI servisi üzerinden) ---
  /** Son konumdan hizmet noktasına tahmini süre. `null` = rota bilgisi yok. */
  routeEtaSeconds: number | null;
  routeProvider: string | null;

  /** Okunamayan/uygulanamayan sinyaller; kural motoru bunları ihlal saymaz. */
  unavailable: string[];
}

/** Bir kuralın tetiklenme sonucu. */
export interface RuleFinding {
  ruleId: string;
  ruleVersion: string;
  severity: RiskLevel;
  /** Kararın dayandığı sayısal gerçekler — ham konum değil. */
  evidence: Record<string, number | string | boolean | null>;
}

/** Sinyalin eksik olduğunu işaretler. */
export function markUnavailable(signals: SafetySignals, name: string): void {
  if (!signals.unavailable.includes(name)) {
    signals.unavailable.push(name);
  }
}

/** İz özeti için okunan örnek — yalnızca gereken alanlar. */
export interface TraceSample {
  capturedAt: Date;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  distanceToServiceMeters: number;
}

export interface TraceSummary {
  movementMeters: number;
  spanSeconds: number;
  sampleCount: number;
  distanceTrendMeters: number;
  longGapCount: number;
  exitCount: number;
  lastConclusiveSide: 'INSIDE' | 'OUTSIDE' | null;
  lastConclusiveAt: Date | null;
}

/** "Uzun boşluk": iki örnek arasında bu kadar (saniye) ya da daha fazla süre. */
export const LONG_GAP_SECONDS = 300;

/**
 * Hareket, pencere süresi ve mesafe eğilimi **son 30 dakikadan** hesaplanır.
 *
 * Tüm iz penceresi (60 dk) kullanılsaydı, yolda takılan bir sağlayıcının takılmadan
 * önceki sürüşü hareketi şişirir ve "ilerleme yok" kuralı (R07) tasarlandığı
 * durumda bile tetiklenemezdi — EXP-004 bu hatayı buldu. Boşluk, çıkış ve kanıt
 * tazeliği tüm pencereden sayılır: tekrar örüntüleri daha uzun ufuk ister.
 */
export const MOVEMENT_WINDOW_SECONDS = 30 * 60;

/**
 * Son penceredeki iz özeti.
 *
 * Hareket, ardışık örnekler arası mesafelerin toplamıdır — ama her adımdan iki
 * örneğin **büyük olan** doğruluğu düşülür. Düşülmeseydi, masada duran bir
 * telefonun GPS jitter'ı onlarca metre "hareket" üretir ve tam da yakalanması
 * gereken hareketsizlik görünmez olurdu. Hizmet noktasına mesafe farkı
 * kullanılmaz: servisin etrafında dönen biri hareketsiz görünürdü.
 */
export function summarizeTrace(
  samples: readonly TraceSample[],
  radiusMeters: number,
): TraceSummary | null {
  if (samples.length < 2) {
    return null;
  }

  const ordered = [...samples].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const band = hysteresisMeters(radiusMeters);
  const side = (sample: TraceSample): 'IN' | 'OUT' | null =>
    sample.distanceToServiceMeters + sample.accuracyMeters <= radiusMeters - band
      ? 'IN'
      : sample.distanceToServiceMeters - sample.accuracyMeters > radiusMeters + band
        ? 'OUT'
        : null;

  const lastAt = (ordered[ordered.length - 1] as TraceSample).capturedAt.getTime();
  const movementFrom = lastAt - MOVEMENT_WINDOW_SECONDS * 1000;
  let movement = 0;
  let longGaps = 0;
  let exits = 0;
  // Çıkış: kesin içeride görüldükten sonra art arda en az iki kesin dışarıda örnek.
  // Yaklaşma (hiç içeride görülmeden dışarıda olmak) çıkış sayılmaz.
  let seenInside = side(ordered[0] as TraceSample) === 'IN';
  let outsideRun = 0;
  let lastConclusive: { side: 'INSIDE' | 'OUTSIDE'; at: Date } | null = null;
  const firstSide = side(ordered[0] as TraceSample);
  if (firstSide !== null) {
    lastConclusive = {
      side: firstSide === 'IN' ? 'INSIDE' : 'OUTSIDE',
      at: (ordered[0] as TraceSample).capturedAt,
    };
  }

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1] as TraceSample;
    const current = ordered[index] as TraceSample;
    if (previous.capturedAt.getTime() >= movementFrom) {
      const step = haversineMeters(previous, current);
      movement += Math.max(0, step - Math.max(previous.accuracyMeters, current.accuracyMeters));
    }
    if (current.capturedAt.getTime() - previous.capturedAt.getTime() >= LONG_GAP_SECONDS * 1000) {
      longGaps += 1;
    }

    const observed = side(current);
    if (observed !== null) {
      lastConclusive = {
        side: observed === 'IN' ? 'INSIDE' : 'OUTSIDE',
        at: current.capturedAt,
      };
    }
    if (observed === 'IN') {
      seenInside = true;
      outsideRun = 0;
    } else if (observed === 'OUT') {
      outsideRun += 1;
      if (outsideRun === 2 && seenInside) {
        exits += 1;
      }
    }
  }

  const last = ordered[ordered.length - 1] as TraceSample;
  const first = ordered.find((sample) => sample.capturedAt.getTime() >= movementFrom) ?? last;

  return {
    movementMeters: Math.round(movement),
    spanSeconds: Math.round((last.capturedAt.getTime() - first.capturedAt.getTime()) / 1000),
    sampleCount: ordered.length,
    distanceTrendMeters: last.distanceToServiceMeters - first.distanceToServiceMeters,
    longGapCount: longGaps,
    exitCount: exits,
    lastConclusiveSide: lastConclusive?.side ?? null,
    lastConclusiveAt: lastConclusive?.at ?? null,
  };
}

/** Oturumun sinyal üretimi için gereken anlık görüntüsü. */
export interface SignalSource {
  status: SafetySessionStatus;
  scheduledStart: Date;
  scheduledEnd: Date;
  telemetryIntervalSeconds: number;
  geofenceRadiusMeters: number;
  monitoringStartedAt: Date | null;
  activatedAt: Date | null;
  activationGeofenceState: GeofenceState | null;
  geofenceState: GeofenceState;
  geofenceStateSince: Date | null;
  lastDistanceMeters: number | null;
  lastTelemetryAt: Date | null;
  telemetryCount: number;
  rejectedCount: number;
  integrityRejectionCount: number;
  mockLocationCount: number;
}

function secondsBetween(later: Date, earlier: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 1000));
}

/**
 * Oturum + iz → normalize sinyaller. Saf fonksiyon: aynı girdi aynı sinyali verir.
 *
 * Rota sinyali burada **yoktur**; AI servisinden gelir ve `withRoute` ile eklenir.
 * Gelmezse `route` eksik olarak işaretli kalır — tahmin uydurulmaz.
 */
export function buildSignals(
  source: SignalSource,
  trace: TraceSummary | null,
  evaluatedAt: Date,
): SafetySignals {
  const signals: SafetySignals = {
    sessionStatus: source.status,
    evaluatedAt,
    scheduledStart: source.scheduledStart,
    scheduledEnd: source.scheduledEnd,
    telemetryIntervalSeconds: source.telemetryIntervalSeconds,
    geofenceRadiusMeters: source.geofenceRadiusMeters,
    monitoringStartedAt: source.monitoringStartedAt,
    activatedAt: source.activatedAt,
    activationGeofenceState: source.activationGeofenceState,
    geofenceState: source.geofenceState,
    geofenceStateSeconds:
      source.geofenceStateSince === null
        ? null
        : secondsBetween(evaluatedAt, source.geofenceStateSince),
    lastDistanceMeters: source.lastDistanceMeters,
    secondsSinceTelemetry: null,
    telemetryCount: source.telemetryCount,
    rejectedCount: source.rejectedCount,
    integrityRejectionCount: source.integrityRejectionCount,
    mockLocationCount: source.mockLocationCount,
    recentMovementMeters: trace?.movementMeters ?? null,
    recentWindowSeconds: trace?.spanSeconds ?? null,
    recentSampleCount: trace?.sampleCount ?? 0,
    distanceTrendMeters: trace?.distanceTrendMeters ?? null,
    recentLongGapCount: trace?.longGapCount ?? null,
    recentExitCount: trace?.exitCount ?? null,
    geofenceEvidenceAgeSeconds:
      trace === null || trace.lastConclusiveAt === null
        ? null
        : secondsBetween(evaluatedAt, trace.lastConclusiveAt),
    geofenceEvidenceSide: trace?.lastConclusiveSide ?? null,
    routeEtaSeconds: null,
    routeProvider: null,
    unavailable: [],
  };

  const reference = source.lastTelemetryAt ?? source.monitoringStartedAt;
  if (reference !== null) {
    signals.secondsSinceTelemetry = secondsBetween(evaluatedAt, reference);
  } else {
    markUnavailable(signals, 'telemetry_gap');
  }

  if (source.telemetryCount === 0) {
    markUnavailable(signals, 'telemetry');
  }
  if (source.geofenceState === 'UNKNOWN') {
    markUnavailable(signals, 'geofence');
  }
  if (trace === null) {
    markUnavailable(signals, 'trace');
  }
  // Rota yalnızca varış aşamasında anlamlıdır; hizmet sırasında "yok" demek
  // eksiklik değil, uygulanamazlıktır ve listeye yazılmaz.
  if (source.status === 'ARRIVAL_MONITORING') {
    markUnavailable(signals, 'route');
  }

  return signals;
}

/** Rota tahminini sinyallere ekler (yalnızca gerçekten geldiyse). */
export function withRoute(
  signals: SafetySignals,
  route: { etaSeconds: number; provider: string } | null,
): SafetySignals {
  if (route === null) {
    return signals;
  }
  return {
    ...signals,
    routeEtaSeconds: route.etaSeconds,
    routeProvider: route.provider,
    unavailable: signals.unavailable.filter((name) => name !== 'route'),
  };
}
