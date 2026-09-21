import { maxRisk, riskRank, type RiskLevel } from '../safety.constants';
import { ruleFamily } from './safety-rules';
import type { RuleFinding } from './safety-signals';

/**
 * Risk seviyesi toplama (ADR-0008 §4, ADR-0019 §6).
 *
 * **Deterministik ve denetlenebilir.** Aynı bulgu kümesi her zaman aynı seviyeyi
 * verir; rastlantısal ya da öğrenilmiş bir bileşen yoktur. Politika dört kuraldır
 * ve her biri kasıtlıdır:
 *
 * 1. **Kurallar arasında en yüksek kazanır.** Ortalama almak, bir yüksek riskli
 *    bulguyu birkaç normal bulgunun içinde eritirdi.
 * 2. **Doğrulama (corroboration) yükseltir.** Birbirinden **bağımsız** iki sinyal
 *    ailesinde uyarı varsa seviye `HIGH_RISK` olur. Aynı ailedeki iki kural
 *    ("geç kalacak" + "uzaklaşıyor") tek davranışın iki yüzüdür ve kendi kendini
 *    doğrulayamaz. Tek bir zayıf sinyal asla tek başına yükselmez.
 * 3. **Anomali skoru destekleyicidir.** Model tek başına en fazla `WARNING`
 *    üretebilir. Bir kural uyarısıyla birlikte `HIGH_RISK`'e taşıyabilmesi için
 *    skorun, uyarı veren ailelerin katkıları çıkarıldıktan sonra da eşiği geçmesi
 *    gerekir (v2): aynı gözlem kendi kendini doğrulayamaz. Düşük kaliteli skor hiç
 *    sayılmaz.
 * 4. **`EMERGENCY` yalnızca panikten gelir.** Hiçbir kural ve model kombinasyonu
 *    otomatik acil durum ilan edemez: acil durum insanın beyanı ya da operatörün
 *    kararıdır. `HIGH_RISK` operatöre alarm üretir; geri dönüşsüz hiçbir işlem yapmaz.
 */

/** Toplama politikasının sürümü; kural kümesinden bağımsız sürümlenir. */
export const RISK_AGGREGATION_VERSION = 'risk-agg-v2';

/**
 * Sürüm geçmişi:
 * - `risk-agg-v1`: bayraklı anomali skoru, **her** kural uyarısının ikinci kanıtı
 *   sayılıyordu. Faz 8 review'u gösterdi ki skor aynı sinyalden geldiğinde (ör. tek
 *   bir 18 dk'lık telemetri boşluğu hem R03'ü hem `telemetry_gap` özelliğini
 *   tetikler) bu "doğrulama" değil, aynı kanıtın iki kez sayılmasıdır ve R02/R03'ün
 *   HIGH_RISK eşiklerini sessizce ~18 dk'ya indiriyordu.
 * - `risk-agg-v2`: anomali yalnızca, uyarı veren ailelere ait özellik katkıları
 *   **çıkarıldıktan sonra** hâlâ bayrak eşiğini geçiyorsa bağımsız kanıt sayılır.
 */

/** Anomali skorunun "işaretli" sayılması için gereken eşik. */
export const ANOMALY_FLAG_THRESHOLD = 0.8;

/**
 * Skorun sayılması için gereken asgari veri kalitesi.
 *
 * Kalite, modelin gerçekten ölçebildiği özelliklerin oranıdır. Yarıdan azı
 * ölçülebilmişse yüksek skor zayıf kanıttır ve riske girmez.
 */
export const ANOMALY_MIN_QUALITY = 0.5;

/**
 * Anomali kaynaklı riskin **tek başına** üst sınırı.
 *
 * "ML asla tek başına yükseltemez" kuralının koddaki tek noktası. Değiştirilmesi
 * bir ADR değişikliği gerektirir.
 */
export const ANOMALY_MAX_LEVEL: RiskLevel = 'WARNING';

export interface AnomalySignal {
  score: number;
  quality: number;
  /**
   * Özellik katkıları. `anomaly-deviation-*` modellerinde skor bu katkıların
   * noisy-OR birleşimidir: `1 − Π(1 − cᵢ)` (AI servisi sözleşmesi). Boşsa model
   * yalnızca tek başına sinyal olabilir, doğrulayıcı olamaz.
   */
  contributions: readonly { feature: string; contribution: number }[];
}

/**
 * Model özelliğinin ölçtüğü sinyal ailesi — kural aileleriyle aynı küme.
 * Bilinmeyen özellik hiçbir aileye bağlanamaz; bağımsız kanıt sayılmaz.
 */
const FEATURE_FAMILY: Record<string, string> = {
  telemetry_gap: 'TELEMETRY',
  repeated_gaps: 'TELEMETRY',
  integrity_rate: 'INTEGRITY',
  mock_rate: 'INTEGRITY',
  arrival_delay: 'ARRIVAL',
  moving_away: 'ARRIVAL',
  projected_lateness: 'ARRIVAL',
  stalled: 'ACTIVITY',
  duration_ratio: 'DURATION',
  outside_dwell: 'LOCATION',
  repeated_exits: 'LOCATION',
};

/**
 * Uyarı veren kural ailelerinin **dışındaki** kanıtla modelin skoru.
 *
 * Aynı gözlemi iki kez saymamak için katkılar aile bazında ayıklanır ve kalanlar
 * noisy-OR ile yeniden birleştirilir. Ailesi bilinmeyen katkı da çıkarılır
 * (bağımsızlığı gösterilemeyen kanıt bağımsız sayılmaz).
 */
export function independentAnomalyScore(
  anomaly: AnomalySignal,
  warningFamilies: readonly string[],
): number {
  let survival = 1;
  for (const item of anomaly.contributions) {
    const family = FEATURE_FAMILY[item.feature];
    if (family === undefined || warningFamilies.includes(family)) {
      continue;
    }
    survival *= 1 - Math.min(1, Math.max(0, item.contribution));
  }
  return 1 - survival;
}

export interface RiskInput {
  findings: RuleFinding[];
  anomaly: AnomalySignal | null;
  /** Kullanıcı paniği — deterministik ve koşulsuz. */
  panicRaised: boolean;
  /**
   * Bayrak eşiği. Üretimde **her zaman** varsayılandır; parametre yalnızca EXP-004
   * duyarlılık analizinin aynı politikayı farklı eşikle çalıştırabilmesi içindir.
   */
  flagThreshold?: number;
}

export type RiskDeterminant = 'USER' | 'RULE' | 'ML' | 'NONE';

export interface RiskOutcome {
  level: RiskLevel;
  /** Seviyeyi belirleyen kaynak; operatör görünümünde gösterilir. */
  determinedBy: RiskDeterminant;
  /** Anomali skoru eşiği ve kalite kapısını geçti mi. */
  anomalyFlagged: boolean;
  /** Anomali seviyeyi değiştirdi mi (tek başına ya da doğrulayıcı olarak). */
  anomalyContributed: boolean;
  /** Doğrulama politikası seviyeyi yükseltti mi. */
  corroborated: boolean;
  /** Uyarı üreten bağımsız sinyal aileleri. */
  warningFamilies: string[];
}

export function isAnomalyFlagged(
  anomaly: AnomalySignal | null,
  threshold: number = ANOMALY_FLAG_THRESHOLD,
): boolean {
  return anomaly !== null && anomaly.quality >= ANOMALY_MIN_QUALITY && anomaly.score >= threshold;
}

export function aggregateRisk(input: RiskInput): RiskOutcome {
  const threshold = input.flagThreshold ?? ANOMALY_FLAG_THRESHOLD;
  const anomalyFlagged = isAnomalyFlagged(input.anomaly, threshold);

  if (input.panicRaised) {
    return {
      level: 'EMERGENCY',
      determinedBy: 'USER',
      anomalyFlagged,
      anomalyContributed: false,
      corroborated: false,
      warningFamilies: [],
    };
  }

  // 1. Kurallar: en yüksek kazanır. Kurallar EMERGENCY üretmez; üretirse (bir
  //    programlama hatası) bile HIGH_RISK'te kesilir.
  let ruleLevel: RiskLevel = 'NORMAL';
  for (const finding of input.findings) {
    const severity = finding.severity === 'EMERGENCY' ? 'HIGH_RISK' : finding.severity;
    ruleLevel = maxRisk(ruleLevel, severity);
  }

  const families = new Set<string>();
  for (const finding of input.findings) {
    if (riskRank(finding.severity) >= riskRank('WARNING')) {
      families.add(ruleFamily(finding.ruleId) ?? finding.ruleId);
    }
  }
  const warningFamilies = [...families].sort();

  let level = ruleLevel;
  let corroborated = false;
  let anomalyContributed = false;

  // 2. Doğrulama: iki bağımsız aile → HIGH_RISK.
  if (riskRank(level) < riskRank('HIGH_RISK') && warningFamilies.length >= 2) {
    level = 'HIGH_RISK';
    corroborated = true;
  }

  // 3. Anomali: tek başına WARNING tavanı; bir kural uyarısıyla birlikte ikinci kanıt.
  if (anomalyFlagged) {
    if (level === 'NORMAL') {
      level = ANOMALY_MAX_LEVEL;
      anomalyContributed = true;
    } else if (
      level === 'WARNING' &&
      warningFamilies.length >= 1 &&
      input.anomaly !== null &&
      independentAnomalyScore(input.anomaly, warningFamilies) >= threshold
    ) {
      // Yalnızca uyarı veren ailelerden **bağımsız** kanıt ikinci kanıttır.
      level = 'HIGH_RISK';
      corroborated = true;
      anomalyContributed = true;
    }
  }

  let determinedBy: RiskDeterminant = 'NONE';
  if (level !== 'NORMAL') {
    determinedBy = anomalyContributed && ruleLevel === 'NORMAL' ? 'ML' : 'RULE';
  }

  return {
    level,
    determinedBy,
    anomalyFlagged,
    anomalyContributed,
    corroborated,
    warningFamilies,
  };
}

/**
 * Hesaplanan seviyenin otomatik olarak uygulanıp uygulanamayacağı.
 *
 * `EMERGENCY` **otomatik olarak düşmez**. Bir panik kaydı, kurallar sustuğu için
 * kendiliğinden kapanamaz; seviyeyi düşürmek operatör kararıdır (ADR-0008 §3).
 * Aksi hâlde sağlayıcı paniğe bastıktan sonra telefonunu cebine koyup hareket
 * ettiğinde sistem "her şey yolunda" der ve alarm sessizce kapanırdı.
 */
export function resolveAppliedLevel(
  current: RiskLevel,
  computed: RiskLevel,
  floor: RiskLevel | null = null,
): RiskLevel {
  if (current === 'EMERGENCY') {
    return 'EMERGENCY';
  }
  // Operatörün süreli tabanı: otomatik değerlendirme operatör kararının altına
  // inemez, üstüne çıkabilir (Faz 8 review M5).
  return floor === null ? computed : maxRisk(computed, floor);
}
