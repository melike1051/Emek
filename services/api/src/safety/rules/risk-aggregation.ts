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
 *    üretebilir; bir kural uyarısıyla **birlikte** ikinci bağımsız kanıt sayılır
 *    (ve `HIGH_RISK`'e taşıyabilir). Düşük kaliteli (az özellikle hesaplanmış) skor
 *    hiç sayılmaz.
 * 4. **`EMERGENCY` yalnızca panikten gelir.** Hiçbir kural ve model kombinasyonu
 *    otomatik acil durum ilan edemez: acil durum insanın beyanı ya da operatörün
 *    kararıdır. `HIGH_RISK` operatöre alarm üretir; geri dönüşsüz hiçbir işlem yapmaz.
 */

/** Toplama politikasının sürümü; kural kümesinden bağımsız sürümlenir. */
export const RISK_AGGREGATION_VERSION = 'risk-agg-v1';

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
}

export interface RiskInput {
  findings: RuleFinding[];
  anomaly: AnomalySignal | null;
  /** Kullanıcı paniği — deterministik ve koşulsuz. */
  panicRaised: boolean;
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

export function isAnomalyFlagged(anomaly: AnomalySignal | null): boolean {
  return (
    anomaly !== null &&
    anomaly.quality >= ANOMALY_MIN_QUALITY &&
    anomaly.score >= ANOMALY_FLAG_THRESHOLD
  );
}

export function aggregateRisk(input: RiskInput): RiskOutcome {
  const anomalyFlagged = isAnomalyFlagged(input.anomaly);

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
    } else if (level === 'WARNING' && warningFamilies.length >= 1) {
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
export function resolveAppliedLevel(current: RiskLevel, computed: RiskLevel): RiskLevel {
  if (current === 'EMERGENCY') {
    return 'EMERGENCY';
  }
  return computed;
}
