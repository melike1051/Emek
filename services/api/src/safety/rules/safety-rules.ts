import type { RiskLevel } from '../safety.constants';
import type { RuleFinding, SafetySignals } from './safety-signals';

/**
 * Deterministik güvenlik kuralları (ADR-0008 §2, ADR-0019 §5).
 *
 * Bu dosya, güvenlik kural mantığının **tamamıdır**. Controller ya da servis içine
 * dağılmış `if` blokları yoktur: dağıldığı anda hangi kuralın hangi sürümle
 * tetiklendiği kayıttan yanıtlanamaz hâle gelir ve yanlış alarm oranı ölçülemez.
 *
 * Kurallar ML'den **bağımsızdır**: anomali skorunu hiçbir kural okumaz. Model
 * erişilemez olsa da hepsi çalışır. Rota tahmini bir **altyapı** sinyalidir (Faz 7
 * routing portu); gelmezse ona bağlı kural "uygulanamaz" olur, tetiklenmez.
 *
 * Hiçbir kural `EMERGENCY` üretmez: acil durum insanın beyanıdır (panik) ya da
 * operatörün kararıdır. Hiçbir kural kişiyi "sahtekâr" ya da "tehlikede" diye
 * etiketlemez; bulgu, operatörün bakması gereken **gözlenmiş bir sapmadır**.
 *
 * Her kuralın kimliği ve sürümü vardır. Eşik değişirse **sürüm artar** (ADR-0012).
 */

/** Kural kümesinin sürümü; her değerlendirmeyle saklanır. */
export const SAFETY_RULESET_VERSION = 'safety-rules-v2';

/**
 * Sinyal aileleri.
 *
 * Toplama (risk-aggregation.ts) "birbirini doğrulayan iki bulgu"yu yükseltme
 * gerekçesi sayar. Aynı davranışın iki yüzü (ör. "geç kalacak" ve "uzaklaşıyor")
 * bağımsız kanıt değildir; aile, korelasyonlu kuralları aynı kovaya koyar ki tek
 * bir davranış kendi kendini doğrulamasın.
 */
export const RULE_FAMILIES = [
  'ARRIVAL',
  'LOCATION',
  'TELEMETRY',
  'DURATION',
  'INTEGRITY',
  'ACTIVITY',
] as const;
export type RuleFamily = (typeof RULE_FAMILIES)[number];

export interface RuleThresholds {
  /** Planlanan başlangıçtan sonra varış için tolerans (saniye). */
  arrivalGraceSeconds: number;
  /** Aktif hizmette hizmet noktası dışında kalma: uyarı eşiği (saniye). */
  geofenceExitWarningSeconds: number;
  /** Aktif hizmette hizmet noktası dışında kalma: yüksek risk eşiği (saniye). */
  geofenceExitHighRiskSeconds: number;
  /** Telemetri boşluğu uyarı eşiği (saniye). */
  telemetryGapWarningSeconds: number;
  /** Telemetri boşluğu yüksek risk eşiği (saniye). */
  telemetryGapHighRiskSeconds: number;
  /** Planlanan süreye göre kabul edilen aşım çarpanı. */
  durationOverrunFactor: number;
  /** Çarpandan bağımsız asgari aşım (saniye): kısa işlerde %50 birkaç dakikadır. */
  durationOverrunMinSeconds: number;
  /** Bütünlük retleri için uyarı eşiği (adet). */
  integrityRejectionWarningCount: number;
  /** Yolda takılma: pencere içinde bunun altındaki (jitter düşülmüş) hareket "ilerleme yok"tur. */
  stalledMaxMovementMeters: number;
  /** Yolda takılma kararı için gereken gözlem penceresi (saniye). */
  stalledWindowSeconds: number;
  /** Hizmet noktasına bundan yakınken bekleme meşrudur (erken varış). */
  stalledMinDistanceMeters: number;
  /** Varış sırasında uzaklaşma eşiği (metre). */
  movingAwayMeters: number;
  /** Geofence kanıtı bu yaştan (saniye) eskiyse konum yargısı "bilinmiyor" sayılır. */
  geofenceEvidenceMaxAgeSeconds: number;
  /** Check-in sonrası hizmet noktasına girmek için tanınan süre (saniye). */
  checkInGraceSeconds: number;
  /** Uzaklaşma kararı için gereken asgari gözlem penceresi (saniye). */
  movingAwayMinWindowSeconds: number;
}

/**
 * Sürüm geçmişi:
 * - `safety-rules-v1`: ilk taslak (yayımlanmadı). EXP-004 geliştirmesi sırasında
 *   R02 ve R10'un bayat geofence durumuna ve debounce gecikmesine dayanarak yanlış
 *   alarm ürettiği görüldü; ölçülen değerler EXP-004 raporunda açıklanır.
 * - `safety-rules-v2`: R02 v2 ve R10 v2 — taze **kesin** geofence kanıtı şartı ve
 *   dışarıda kalma süresinin check-in'den itibaren sayılması.
 */

/**
 * Başlangıç eşikleri.
 *
 * Hiçbiri "deneyle bulunmuş en iyi değer" değildir; gerçek hizmet verisi yokken
 * makul kabul edilen başlangıç değerleridir ve `SAFETY_RULESET_VERSION` ile birlikte
 * sürümlenir (R-57). EXP-004 bu eşiklerin sentetik senaryolardaki davranışını
 * ölçer; gerçek veriyle kalibrasyon ayrı bir iştir.
 */
export const DEFAULT_RULE_THRESHOLDS: RuleThresholds = {
  arrivalGraceSeconds: 15 * 60,
  geofenceExitWarningSeconds: 5 * 60,
  geofenceExitHighRiskSeconds: 20 * 60,
  telemetryGapWarningSeconds: 10 * 60,
  telemetryGapHighRiskSeconds: 30 * 60,
  durationOverrunFactor: 1.5,
  durationOverrunMinSeconds: 30 * 60,
  integrityRejectionWarningCount: 3,
  stalledMaxMovementMeters: 50,
  stalledWindowSeconds: 30 * 60,
  stalledMinDistanceMeters: 1000,
  movingAwayMeters: 1000,
  movingAwayMinWindowSeconds: 10 * 60,
  geofenceEvidenceMaxAgeSeconds: 5 * 60,
  checkInGraceSeconds: 5 * 60,
};

export interface SafetyRule {
  id: string;
  version: string;
  family: RuleFamily;
  /** İnsan tarafından okunabilir amaç — dokümantasyon ve operatör görünümü için. */
  description: string;
  /** Kuralın okuduğu sinyaller; biri eksikse kural "uygulanamaz"dır. */
  inputs: readonly (keyof SafetySignals)[];
  evaluate(signals: SafetySignals, thresholds: RuleThresholds): RuleFinding | null;
}

function finding(
  rule: { id: string; version: string },
  severity: RiskLevel,
  evidence: Record<string, number | string | boolean | null>,
): RuleFinding {
  return { ruleId: rule.id, ruleVersion: rule.version, severity, evidence };
}

function secondsSince(signals: SafetySignals, reference: Date): number {
  return Math.floor((signals.evaluatedAt.getTime() - reference.getTime()) / 1000);
}

/**
 * SAFETY-R01 — Sağlayıcı beklenen saatte varmadı.
 *
 * Yalnızca varış izleme aşamasında anlamlıdır. Tolerans sonrası hâlâ check-in
 * yoksa **uyarı** üretir: trafik ve gecikme olağandır, gecikmeyi tehlike saymak
 * yanlış alarm üretir.
 */
const MISSED_ARRIVAL: SafetyRule = {
  id: 'SAFETY-R01',
  version: 'v1',
  family: 'ARRIVAL',
  description: 'Planlanan başlangıç + tolerans geçti, sağlayıcı hâlâ check-in yapmadı',
  inputs: ['scheduledStart'],
  evaluate(signals, thresholds) {
    if (signals.sessionStatus !== 'ARRIVAL_MONITORING') {
      return null;
    }
    const lateSeconds = secondsSince(signals, signals.scheduledStart);
    if (lateSeconds <= thresholds.arrivalGraceSeconds) {
      return null;
    }
    return finding(MISSED_ARRIVAL, 'WARNING', {
      expectedBy: signals.scheduledStart.toISOString(),
      lateSeconds,
      graceSeconds: thresholds.arrivalGraceSeconds,
      geofenceState: signals.geofenceState,
    });
  },
};

/** Son kesin geofence gözlemi taze ve "dışarıda" mı? */
function freshOutsideEvidence(signals: SafetySignals, thresholds: RuleThresholds): boolean {
  return (
    signals.geofenceEvidenceSide === 'OUTSIDE' &&
    signals.geofenceEvidenceAgeSeconds !== null &&
    signals.geofenceEvidenceAgeSeconds <= thresholds.geofenceEvidenceMaxAgeSeconds
  );
}

/**
 * SAFETY-R02 (v2) — Aktif hizmet sırasında hizmet noktası dışında kalındı.
 *
 * Kısa çıkışlar olağandır (çöp atmak, araca gitmek, malzeme almak). İki kademelidir:
 * 5 dakika uyarı, 20 dakika yüksek risk. İki koşul v1'e göre yenidir:
 *
 * - Süre **check-in'den** itibaren sayılır: varış yolundaki "dışarıda" süresi
 *   hizmette dışarıda kalma değildir.
 * - Son kesin gözlem **taze** ve "dışarıda" olmalıdır. Kapalı alanda GPS kesin
 *   gözlem üretmeyi bırakınca debounce edilmiş durum eskir ama değişmez; eski bir
 *   "dışarıda" kanıtla alarm üretmek bina içindeki sağlayıcıyı kaçmış gibi gösterir.
 */
const UNEXPECTED_EXIT: SafetyRule = {
  id: 'SAFETY-R02',
  version: 'v2',
  family: 'LOCATION',
  description: 'Aktif hizmette hizmet noktası dışında uzun süre kalındı',
  inputs: ['geofenceState', 'geofenceStateSeconds', 'geofenceEvidenceAgeSeconds'],
  evaluate(signals, thresholds) {
    if (
      signals.sessionStatus !== 'ACTIVE' ||
      signals.geofenceState !== 'OUTSIDE' ||
      signals.geofenceStateSeconds === null ||
      signals.activatedAt === null ||
      !freshOutsideEvidence(signals, thresholds)
    ) {
      return null;
    }
    const outside = Math.min(
      signals.geofenceStateSeconds,
      Math.max(0, secondsSince(signals, signals.activatedAt)),
    );
    if (outside <= thresholds.geofenceExitWarningSeconds) {
      return null;
    }
    const severity: RiskLevel =
      outside > thresholds.geofenceExitHighRiskSeconds ? 'HIGH_RISK' : 'WARNING';
    return finding(UNEXPECTED_EXIT, severity, {
      outsideSeconds: outside,
      warningSeconds: thresholds.geofenceExitWarningSeconds,
      highRiskSeconds: thresholds.geofenceExitHighRiskSeconds,
      evidenceAgeSeconds: signals.geofenceEvidenceAgeSeconds,
      lastDistanceMeters: signals.lastDistanceMeters,
      radiusMeters: signals.geofenceRadiusMeters,
    });
  },
};

/**
 * SAFETY-R03 — Telemetri kesildi.
 *
 * İki kademelidir: 10 dakika uyarı, 30 dakika yüksek risk. Telefonun pili bitebilir
 * ya da işletim sistemi uygulamayı uyutabilir — ama uzun bir sessizlik **tam
 * olarak** bir güvenlik sisteminin fark etmesi gereken şeydir. Hiç telemetri
 * gelmediyse boşluk izlemenin başladığı andan ölçülür: veri yokluğu "normal" değildir.
 */
const TELEMETRY_GAP: SafetyRule = {
  id: 'SAFETY-R03',
  version: 'v1',
  family: 'TELEMETRY',
  description: 'Aktif oturumda telemetri akışı kesildi',
  inputs: ['secondsSinceTelemetry'],
  evaluate(signals, thresholds) {
    if (signals.sessionStatus !== 'ACTIVE' && signals.sessionStatus !== 'ARRIVAL_MONITORING') {
      return null;
    }
    const gap = signals.secondsSinceTelemetry;
    if (gap === null || gap < thresholds.telemetryGapWarningSeconds) {
      return null;
    }
    const severity: RiskLevel =
      gap >= thresholds.telemetryGapHighRiskSeconds ? 'HIGH_RISK' : 'WARNING';
    return finding(TELEMETRY_GAP, severity, {
      gapSeconds: gap,
      expectedIntervalSeconds: signals.telemetryIntervalSeconds,
      warningSeconds: thresholds.telemetryGapWarningSeconds,
      highRiskSeconds: thresholds.telemetryGapHighRiskSeconds,
      telemetryEverReceived: signals.telemetryCount > 0,
    });
  },
};

/**
 * SAFETY-R04 — Hizmet planlanandan belirgin biçimde uzun sürdü.
 *
 * Uyarı seviyesindedir: uzun süren hizmet çoğunlukla meşrudur (ek iş, müşteri
 * talebi). Amaç cezalandırmak değil, operatörün bakması için işaretlemek. Hem
 * çarpan hem asgari süre aşılmalıdır: 1 saatlik işte %50 yalnızca 30 dakikadır.
 */
const DURATION_OVERRUN: SafetyRule = {
  id: 'SAFETY-R04',
  version: 'v1',
  family: 'DURATION',
  description: 'Hizmet süresi planlanan süreyi belirgin biçimde aştı',
  inputs: ['activatedAt'],
  evaluate(signals, thresholds) {
    if (signals.sessionStatus !== 'ACTIVE' || signals.activatedAt === null) {
      return null;
    }
    const plannedSeconds = Math.max(
      1,
      Math.floor((signals.scheduledEnd.getTime() - signals.scheduledStart.getTime()) / 1000),
    );
    const actualSeconds = secondsSince(signals, signals.activatedAt);
    const limit = Math.max(
      plannedSeconds * thresholds.durationOverrunFactor,
      plannedSeconds + thresholds.durationOverrunMinSeconds,
    );
    if (actualSeconds <= limit) {
      return null;
    }
    return finding(DURATION_OVERRUN, 'WARNING', {
      plannedSeconds,
      actualSeconds,
      limitSeconds: Math.round(limit),
    });
  },
};

/**
 * SAFETY-R05 — Telemetri bütünlük ihlali.
 *
 * İmkânsız hız, saat geri gitmesi ve geleceğe tarihli örnekler ingest'te reddedilir
 * ve sayılır. Eşik birden büyüktür: tek bir kötü GPS fix'i (ör. cihazın ilk
 * açılıştaki konumu) olağandır. Bulgu "dolandırıcılık" demek **değildir** — bozuk
 * bir GPS yongası da aynı sayacı artırır; konum verisinin kanıt değeri zayıflamıştır.
 */
const TELEMETRY_INTEGRITY: SafetyRule = {
  id: 'SAFETY-R05',
  version: 'v1',
  family: 'INTEGRITY',
  description: 'Fiziksel olarak mümkün olmayan ya da zamanı tutarsız örnekler reddedildi',
  inputs: ['integrityRejectionCount'],
  evaluate(signals, thresholds) {
    if (signals.integrityRejectionCount < thresholds.integrityRejectionWarningCount) {
      return null;
    }
    return finding(TELEMETRY_INTEGRITY, 'WARNING', {
      integrityRejectionCount: signals.integrityRejectionCount,
      telemetryCount: signals.telemetryCount,
      thresholdCount: thresholds.integrityRejectionWarningCount,
    });
  },
};

/**
 * SAFETY-R06 — Sahte konum sağlayıcısı sinyali.
 *
 * Platformun `isMock` işareti bir **bütünlük** sorunudur: bu oturumun konum verisi
 * artık güvenlik kararı için güvenilir değildir, yani izleme kısmen kördür. Uyarı
 * seviyesindedir; tek başına ceza ya da suçlama üretmez (ADR-0008 §6).
 */
const MOCK_LOCATION: SafetyRule = {
  id: 'SAFETY-R06',
  version: 'v1',
  family: 'INTEGRITY',
  description: 'Telemetride sahte konum sağlayıcısı sinyali görüldü',
  inputs: ['mockLocationCount'],
  evaluate(signals) {
    if (signals.mockLocationCount <= 0) {
      return null;
    }
    return finding(MOCK_LOCATION, 'WARNING', {
      mockLocationCount: signals.mockLocationCount,
      telemetryCount: signals.telemetryCount,
    });
  },
};

/**
 * SAFETY-R07 — Varış sırasında uzun süre ilerleme yok (yolda takılma).
 *
 * **Hizmet sırasında uygulanmaz** ve bu bilinçli bir tasarım kararıdır (EXP-004
 * tasarımı sırasında bulundu): GPS bir dairenin içindeki hareketi göremez. Kapalı
 * alanda doğruluk 20-60 m'dir, oda birkaç metredir; jitter düşülmüş hareket
 * temizlik yapan bir sağlayıcı için de sıfırdır. "Hizmette hareketsizlik" kuralı
 * neredeyse her uzun işte yanlış alarm üretirdi. Hareketsizliği güvenle gözlemlemek
 * cihazın hareket sensörünü gerektirir (R-62).
 *
 * GPS'in gerçekten gözlemleyebildiği durum: sağlayıcı yola çıkmış, hizmet noktasından
 * uzakta ve uzun süredir **ilerlemiyor**. Hizmet noktasının yakınında erken gelip
 * bekleyen sağlayıcı (meşru) mesafe koşuluyla dışarıda kalır.
 */
const STALLED_EN_ROUTE: SafetyRule = {
  id: 'SAFETY-R07',
  version: 'v1',
  family: 'ACTIVITY',
  description: 'Varış izlemede hizmet noktasından uzakta uzun süre ilerleme gözlenmedi',
  inputs: ['recentMovementMeters', 'recentWindowSeconds', 'lastDistanceMeters'],
  evaluate(signals, thresholds) {
    if (signals.sessionStatus !== 'ARRIVAL_MONITORING') {
      return null;
    }
    if (
      signals.recentMovementMeters === null ||
      signals.recentWindowSeconds === null ||
      signals.lastDistanceMeters === null ||
      signals.recentWindowSeconds < thresholds.stalledWindowSeconds * 0.9
    ) {
      return null;
    }
    if (
      signals.lastDistanceMeters < thresholds.stalledMinDistanceMeters ||
      signals.recentMovementMeters >= thresholds.stalledMaxMovementMeters
    ) {
      return null;
    }
    return finding(STALLED_EN_ROUTE, 'WARNING', {
      movementMeters: signals.recentMovementMeters,
      windowSeconds: signals.recentWindowSeconds,
      lastDistanceMeters: signals.lastDistanceMeters,
      maxMovementMeters: thresholds.stalledMaxMovementMeters,
    });
  },
};

/**
 * SAFETY-R08 — Rota tahminine göre varış toleransı aşılacak.
 *
 * Son konumdan hizmet noktasına tahmini süre (routing portu) şimdiye eklendiğinde
 * planlanan başlangıç + tolerans aşılıyorsa uyarı. R01'in **erken** hâlidir; R01
 * zaten tetiklenmişse tekrar etmez. Rota bilgisi yoksa uygulanmaz — tahmin uydurulmaz.
 */
const PROJECTED_LATE_ARRIVAL: SafetyRule = {
  id: 'SAFETY-R08',
  version: 'v1',
  family: 'ARRIVAL',
  description: 'Rota tahminine göre sağlayıcı tolerans içinde varamayacak',
  inputs: ['routeEtaSeconds'],
  evaluate(signals, thresholds) {
    if (signals.sessionStatus !== 'ARRIVAL_MONITORING' || signals.routeEtaSeconds === null) {
      return null;
    }
    const deadline = signals.scheduledStart.getTime() + thresholds.arrivalGraceSeconds * 1000;
    if (signals.evaluatedAt.getTime() > deadline) {
      return null;
    }
    const projected = signals.evaluatedAt.getTime() + signals.routeEtaSeconds * 1000;
    if (projected <= deadline) {
      return null;
    }
    return finding(PROJECTED_LATE_ARRIVAL, 'WARNING', {
      etaSeconds: signals.routeEtaSeconds,
      projectedLateSeconds: Math.round((projected - signals.scheduledStart.getTime()) / 1000),
      graceSeconds: thresholds.arrivalGraceSeconds,
      routeProvider: signals.routeProvider,
    });
  },
};

/**
 * SAFETY-R09 — Varış sırasında hizmet noktasından uzaklaşma (rota sapması).
 *
 * Yol ağına göre gerçek bir sapma ölçümü değildir (R-60): hizmet noktasına olan
 * mesafenin gözlem penceresi boyunca **belirgin biçimde artması**dır. Trafikten
 * kaçınmak için kısa süreli uzaklaşma olağandır; eşik (1 km) ve asgari pencere
 * (10 dk) bunun için vardır.
 */
const MOVING_AWAY: SafetyRule = {
  id: 'SAFETY-R09',
  version: 'v1',
  family: 'ARRIVAL',
  description: 'Varış izlemede hizmet noktasından belirgin biçimde uzaklaşıldı',
  inputs: ['distanceTrendMeters', 'recentWindowSeconds'],
  evaluate(signals, thresholds) {
    if (
      signals.sessionStatus !== 'ARRIVAL_MONITORING' ||
      signals.distanceTrendMeters === null ||
      signals.recentWindowSeconds === null ||
      signals.recentWindowSeconds < thresholds.movingAwayMinWindowSeconds
    ) {
      return null;
    }
    if (signals.distanceTrendMeters < thresholds.movingAwayMeters) {
      return null;
    }
    return finding(MOVING_AWAY, 'WARNING', {
      distanceIncreaseMeters: signals.distanceTrendMeters,
      windowSeconds: signals.recentWindowSeconds,
      thresholdMeters: thresholds.movingAwayMeters,
      lastDistanceMeters: signals.lastDistanceMeters,
    });
  },
};

/**
 * SAFETY-R10 (v2) — Check-in yapıldı ama sağlayıcı hizmet noktasına gelmedi.
 *
 * v1 yalnızca check-in anındaki durumuna bakıyordu ve debounce gecikmesini
 * (≈ 3 örnek) ihlal sanıyordu: kapıya varıp hemen check-in yapan sağlayıcı
 * "dışarıdayken check-in yaptı" görünüyordu. v2: check-in anında kesin `OUTSIDE`
 * **ve** check-in'den 5 dakika sonra hâlâ içeride görülmemiş **ve** son kesin
 * gözlem taze ve dışarıda. Geofence tek başına hizmetin başladığını kanıtlamaz;
 * bu bulgu yalnızca bir tutarsızlık kaydıdır.
 */
const CHECKIN_OUTSIDE_GEOFENCE: SafetyRule = {
  id: 'SAFETY-R10',
  version: 'v2',
  family: 'LOCATION',
  description: 'Check-in yapıldı ama sağlayıcı hizmet noktasında görülmedi',
  inputs: ['activationGeofenceState', 'geofenceState', 'geofenceEvidenceAgeSeconds'],
  evaluate(signals, thresholds) {
    if (
      signals.sessionStatus !== 'ACTIVE' ||
      signals.activationGeofenceState !== 'OUTSIDE' ||
      signals.activatedAt === null ||
      signals.geofenceState === 'INSIDE' ||
      secondsSince(signals, signals.activatedAt) < thresholds.checkInGraceSeconds ||
      !freshOutsideEvidence(signals, thresholds)
    ) {
      return null;
    }
    return finding(CHECKIN_OUTSIDE_GEOFENCE, 'WARNING', {
      activationGeofenceState: signals.activationGeofenceState,
      currentGeofenceState: signals.geofenceState,
      secondsSinceCheckIn: secondsSince(signals, signals.activatedAt),
    });
  },
};

/** Kayıtlı kurallar. Sıra sabittir: değerlendirme çıktısı deterministik olmalı. */
export const SAFETY_RULES: readonly SafetyRule[] = [
  MISSED_ARRIVAL,
  UNEXPECTED_EXIT,
  TELEMETRY_GAP,
  DURATION_OVERRUN,
  TELEMETRY_INTEGRITY,
  MOCK_LOCATION,
  STALLED_EN_ROUTE,
  PROJECTED_LATE_ARRIVAL,
  MOVING_AWAY,
  CHECKIN_OUTSIDE_GEOFENCE,
];

const RULE_INDEX = new Map(SAFETY_RULES.map((rule) => [rule.id, rule]));

export function ruleFamily(ruleId: string): RuleFamily | null {
  return RULE_INDEX.get(ruleId)?.family ?? null;
}

/** Tüm kuralları sırayla çalıştırır. Aynı sinyal her zaman aynı bulguyu verir. */
export function evaluateRules(
  signals: SafetySignals,
  thresholds: RuleThresholds = DEFAULT_RULE_THRESHOLDS,
): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const rule of SAFETY_RULES) {
    const result = rule.evaluate(signals, thresholds);
    if (result !== null) {
      findings.push(result);
    }
  }
  return findings;
}
