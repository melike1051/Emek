import {
  ANOMALY_FLAG_THRESHOLD,
  ANOMALY_MIN_QUALITY,
  aggregateRisk,
  resolveAppliedLevel,
} from './risk-aggregation';
import type { RuleFinding } from './safety-signals';

function finding(ruleId: string, severity: RuleFinding['severity']): RuleFinding {
  return { ruleId, ruleVersion: 'v1', severity, evidence: {} };
}

const strongAnomaly = { score: 0.95, quality: 1 };

/**
 * Risk toplama (ADR-0008 §4): deterministik, belgelenmiş, tek zayıf sinyal asla
 * acil duruma çıkmaz.
 */
describe('aggregateRisk', () => {
  it('bulgu ve anomali yoksa NORMAL', () => {
    expect(aggregateRisk({ findings: [], anomaly: null, panicRaised: false })).toMatchObject({
      level: 'NORMAL',
      determinedBy: 'NONE',
    });
  });

  it('tek uyarı WARNING kalır (tek zayıf sinyal yükselmez)', () => {
    const outcome = aggregateRisk({
      findings: [finding('SAFETY-R04', 'WARNING')],
      anomaly: null,
      panicRaised: false,
    });

    expect(outcome).toMatchObject({ level: 'WARNING', corroborated: false, determinedBy: 'RULE' });
  });

  it('en yüksek bulgu kazanır (ortalama alınmaz)', () => {
    expect(
      aggregateRisk({
        findings: [finding('SAFETY-R02', 'HIGH_RISK')],
        anomaly: null,
        panicRaised: false,
      }).level,
    ).toBe('HIGH_RISK');
  });

  it('iki bağımsız aileden uyarı HIGH_RISK olur (doğrulama)', () => {
    const outcome = aggregateRisk({
      findings: [finding('SAFETY-R03', 'WARNING'), finding('SAFETY-R04', 'WARNING')],
      anomaly: null,
      panicRaised: false,
    });

    expect(outcome).toMatchObject({
      level: 'HIGH_RISK',
      corroborated: true,
      warningFamilies: ['DURATION', 'TELEMETRY'],
    });
  });

  it('aynı ailedeki iki kural kendi kendini doğrulayamaz', () => {
    // "Geç kalacak" (R08) ve "uzaklaşıyor" (R09) aynı davranışın iki yüzüdür.
    const outcome = aggregateRisk({
      findings: [finding('SAFETY-R08', 'WARNING'), finding('SAFETY-R09', 'WARNING')],
      anomaly: null,
      panicRaised: false,
    });

    expect(outcome.level).toBe('WARNING');
    expect(outcome.corroborated).toBe(false);
  });

  it('anomali tek başına en fazla WARNING üretir', () => {
    const outcome = aggregateRisk({ findings: [], anomaly: strongAnomaly, panicRaised: false });

    expect(outcome).toMatchObject({
      level: 'WARNING',
      determinedBy: 'ML',
      anomalyFlagged: true,
      anomalyContributed: true,
    });
  });

  it('anomali bir kural uyarısıyla birlikte ikinci kanıt sayılır', () => {
    const outcome = aggregateRisk({
      findings: [finding('SAFETY-R03', 'WARNING')],
      anomaly: strongAnomaly,
      panicRaised: false,
    });

    expect(outcome).toMatchObject({ level: 'HIGH_RISK', corroborated: true, determinedBy: 'RULE' });
  });

  it('düşük kaliteli skor hiç sayılmaz', () => {
    const outcome = aggregateRisk({
      findings: [],
      anomaly: { score: 0.99, quality: ANOMALY_MIN_QUALITY - 0.01 },
      panicRaised: false,
    });

    expect(outcome.level).toBe('NORMAL');
    expect(outcome.anomalyFlagged).toBe(false);
  });

  it('eşik altındaki skor sayılmaz', () => {
    expect(
      aggregateRisk({
        findings: [],
        anomaly: { score: ANOMALY_FLAG_THRESHOLD - 0.01, quality: 1 },
        panicRaised: false,
      }).level,
    ).toBe('NORMAL');
  });

  it('hiçbir kural/model kombinasyonu EMERGENCY üretmez', () => {
    const outcome = aggregateRisk({
      findings: [
        finding('SAFETY-R02', 'HIGH_RISK'),
        finding('SAFETY-R03', 'HIGH_RISK'),
        finding('SAFETY-R06', 'WARNING'),
        // Programlama hatası simülasyonu: kural EMERGENCY üretse bile kesilir.
        finding('SAFETY-R04', 'EMERGENCY'),
      ],
      anomaly: { score: 1, quality: 1 },
      panicRaised: false,
    });

    expect(outcome.level).toBe('HIGH_RISK');
  });

  it('panik koşulsuz EMERGENCY üretir (model ve kurallardan bağımsız)', () => {
    expect(aggregateRisk({ findings: [], anomaly: null, panicRaised: true })).toMatchObject({
      level: 'EMERGENCY',
      determinedBy: 'USER',
    });
  });

  it('aynı girdi aynı sonucu verir', () => {
    const input = {
      findings: [finding('SAFETY-R03', 'WARNING'), finding('SAFETY-R06', 'WARNING')],
      anomaly: strongAnomaly,
      panicRaised: false,
    };

    expect(aggregateRisk(input)).toEqual(aggregateRisk(input));
  });
});

describe('resolveAppliedLevel', () => {
  it('EMERGENCY otomatik olarak düşmez', () => {
    expect(resolveAppliedLevel('EMERGENCY', 'NORMAL')).toBe('EMERGENCY');
  });

  it('diğer seviyeler yükselir ve düşer (de-escalation)', () => {
    expect(resolveAppliedLevel('NORMAL', 'HIGH_RISK')).toBe('HIGH_RISK');
    expect(resolveAppliedLevel('HIGH_RISK', 'WARNING')).toBe('WARNING');
    expect(resolveAppliedLevel('WARNING', 'NORMAL')).toBe('NORMAL');
  });
});
