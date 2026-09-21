import {
  DEFAULT_RULE_THRESHOLDS,
  SAFETY_RULES,
  SAFETY_RULESET_VERSION,
  evaluateRules,
  ruleFamily,
} from './safety-rules';
import type { SafetySignals } from './safety-signals';
import { activeSignals, arrivalSignals } from './signals.fixture';

function ids(signals: SafetySignals): string[] {
  return evaluateRules(signals).map((finding) => finding.ruleId);
}

function severityOf(signals: SafetySignals, ruleId: string): string | undefined {
  return evaluateRules(signals).find((finding) => finding.ruleId === ruleId)?.severity;
}

describe('safety rules', () => {
  it('olağan aktif hizmet ve olağan varış hiçbir kuralı tetiklemez', () => {
    expect(ids(activeSignals())).toEqual([]);
    expect(ids(arrivalSignals())).toEqual([]);
  });

  it('her kural kimlik, sürüm ve aile taşır; kimlikler tekildir', () => {
    const seen = new Set<string>();
    for (const rule of SAFETY_RULES) {
      expect(rule.id).toMatch(/^SAFETY-R\d{2}$/);
      expect(rule.version).toMatch(/^v\d+$/);
      expect(ruleFamily(rule.id)).toBe(rule.family);
      expect(seen.has(rule.id)).toBe(false);
      seen.add(rule.id);
    }
    expect(SAFETY_RULESET_VERSION).toBe('safety-rules-v2');
  });

  it('hiçbir kural EMERGENCY üretmez', () => {
    const extreme = activeSignals({
      geofenceState: 'OUTSIDE',
      geofenceStateSeconds: 100_000,
      secondsSinceTelemetry: 100_000,
      integrityRejectionCount: 1000,
      mockLocationCount: 1000,
      activationGeofenceState: 'OUTSIDE',
      evaluatedAt: new Date('2026-10-06T12:00:00.000Z'),
    });
    for (const finding of evaluateRules(extreme)) {
      expect(finding.severity).not.toBe('EMERGENCY');
    }
  });

  describe('SAFETY-R01 — geç varış', () => {
    it('tolerans içinde tetiklenmez, sonrasında WARNING', () => {
      const withinGrace = arrivalSignals({ evaluatedAt: new Date('2026-10-05T11:14:00.000Z') });
      const late = arrivalSignals({ evaluatedAt: new Date('2026-10-05T11:16:00.000Z') });

      expect(ids(withinGrace)).not.toContain('SAFETY-R01');
      expect(severityOf(late, 'SAFETY-R01')).toBe('WARNING');
    });

    it('beklenen ve gözlenen değer kanıtta açıkça durur', () => {
      const late = arrivalSignals({ evaluatedAt: new Date('2026-10-05T11:40:00.000Z') });
      const finding = evaluateRules(late).find((item) => item.ruleId === 'SAFETY-R01');

      expect(finding?.evidence).toMatchObject({
        expectedBy: '2026-10-05T11:00:00.000Z',
        lateSeconds: 40 * 60,
      });
    });
  });

  describe('SAFETY-R02 — beklenmeyen çıkış (v2)', () => {
    const outside = (overrides: Partial<SafetySignals> = {}) =>
      activeSignals({
        geofenceState: 'OUTSIDE',
        geofenceEvidenceSide: 'OUTSIDE',
        geofenceEvidenceAgeSeconds: 30,
        ...overrides,
      });

    it('kısa geçici çıkış tetiklemez', () => {
      expect(ids(outside({ geofenceStateSeconds: 240 }))).not.toContain('SAFETY-R02');
    });

    it('5 dakika sonrası WARNING, 20 dakika sonrası HIGH_RISK', () => {
      expect(severityOf(outside({ geofenceStateSeconds: 400 }), 'SAFETY-R02')).toBe('WARNING');
      expect(severityOf(outside({ geofenceStateSeconds: 1300 }), 'SAFETY-R02')).toBe('HIGH_RISK');
    });

    it('zayıf GPS (INSUFFICIENT_ACCURACY/BOUNDARY) ihlal sayılmaz', () => {
      for (const state of ['INSUFFICIENT_ACCURACY', 'BOUNDARY'] as const) {
        expect(ids(outside({ geofenceState: state, geofenceStateSeconds: 5000 }))).toEqual([]);
      }
    });

    it('bayat kanıt: bina içinde kesin gözlem kesilince "dışarıda" sayılmaz', () => {
      expect(
        ids(outside({ geofenceStateSeconds: 5000, geofenceEvidenceAgeSeconds: 900 })),
      ).not.toContain('SAFETY-R02');
      expect(
        ids(outside({ geofenceStateSeconds: 5000, geofenceEvidenceSide: 'INSIDE' })),
      ).not.toContain('SAFETY-R02');
    });

    it('süre check-in anından sayılır: varış yolundaki dışarıda süre sayılmaz', () => {
      // Durum 2 saattir OUTSIDE (yaklaşma) ama check-in 3 dakika önce.
      const signals = outside({
        geofenceStateSeconds: 7200,
        activatedAt: new Date('2026-10-05T11:57:00.000Z'),
      });

      expect(ids(signals)).not.toContain('SAFETY-R02');
    });
  });

  describe('SAFETY-R03 — telemetri boşluğu', () => {
    it('10 dk WARNING, 30 dk HIGH_RISK', () => {
      expect(severityOf(activeSignals({ secondsSinceTelemetry: 700 }), 'SAFETY-R03')).toBe(
        'WARNING',
      );
      expect(severityOf(activeSignals({ secondsSinceTelemetry: 1900 }), 'SAFETY-R03')).toBe(
        'HIGH_RISK',
      );
    });

    it('hiç telemetri gelmemesi "normal" sayılmaz', () => {
      const finding = evaluateRules(
        arrivalSignals({ telemetryCount: 0, secondsSinceTelemetry: 1900 }),
      ).find((item) => item.ruleId === 'SAFETY-R03');

      expect(finding?.severity).toBe('HIGH_RISK');
      expect(finding?.evidence.telemetryEverReceived).toBe(false);
    });

    it('sinyal yoksa (null) tetiklenmez', () => {
      expect(ids(activeSignals({ secondsSinceTelemetry: null }))).not.toContain('SAFETY-R03');
    });
  });

  describe('SAFETY-R04 — süre aşımı', () => {
    it('meşru küçük aşım tetiklemez; belirgin aşım WARNING', () => {
      // Planlanan 2 saat; limit max(3 saat, 2.5 saat) = 3 saat.
      const modest = activeSignals({ evaluatedAt: new Date('2026-10-05T13:45:00.000Z') });
      const large = activeSignals({ evaluatedAt: new Date('2026-10-05T14:05:00.000Z') });

      expect(ids(modest)).not.toContain('SAFETY-R04');
      expect(severityOf(large, 'SAFETY-R04')).toBe('WARNING');
    });
  });

  describe('SAFETY-R05 / R06 — bütünlük', () => {
    it('tek kötü fix tetiklemez, tekrarlayan bütünlük ihlali WARNING', () => {
      expect(ids(activeSignals({ integrityRejectionCount: 1 }))).not.toContain('SAFETY-R05');
      expect(severityOf(activeSignals({ integrityRejectionCount: 3 }), 'SAFETY-R05')).toBe(
        'WARNING',
      );
    });

    it('sahte konum sinyali WARNING (ceza/etiket değil)', () => {
      expect(severityOf(activeSignals({ mockLocationCount: 1 }), 'SAFETY-R06')).toBe('WARNING');
    });
  });

  describe('SAFETY-R07 — yolda takılma', () => {
    it('uzakta ve ilerlemiyorsa WARNING', () => {
      expect(
        severityOf(
          arrivalSignals({ recentMovementMeters: 10, recentWindowSeconds: 1800 }),
          'SAFETY-R07',
        ),
      ).toBe('WARNING');
    });

    it('hizmet noktasının yakınında erken gelip beklemek meşrudur', () => {
      expect(
        ids(
          arrivalSignals({
            recentMovementMeters: 0,
            recentWindowSeconds: 1800,
            lastDistanceMeters: 300,
          }),
        ),
      ).not.toContain('SAFETY-R07');
    });

    it('hizmet sırasında uygulanmaz: GPS daire içindeki hareketi göremez', () => {
      expect(
        ids(activeSignals({ recentMovementMeters: 0, recentWindowSeconds: 7200 })),
      ).not.toContain('SAFETY-R07');
    });

    it('kısa pencere yolda takılma sayılmaz', () => {
      expect(
        ids(arrivalSignals({ recentMovementMeters: 0, recentWindowSeconds: 900 })),
      ).not.toContain('SAFETY-R07');
    });
  });

  describe('SAFETY-R08 — rota tahminine göre geç kalma', () => {
    it('rota tahmini tolerans dışını gösteriyorsa WARNING', () => {
      // 10:45'te, ETA 45 dk → 11:30 > 11:15.
      expect(severityOf(arrivalSignals({ routeEtaSeconds: 2700 }), 'SAFETY-R08')).toBe('WARNING');
    });

    it('rota bilgisi yoksa uygulanmaz — tahmin uydurulmaz', () => {
      expect(ids(arrivalSignals({ routeEtaSeconds: null, routeProvider: null }))).toEqual([]);
    });

    it('yavaş trafik ama tolerans içinde: tetiklenmez', () => {
      expect(ids(arrivalSignals({ routeEtaSeconds: 1500 }))).not.toContain('SAFETY-R08');
    });
  });

  describe('SAFETY-R09 — uzaklaşma', () => {
    it('belirgin uzaklaşma WARNING; kısa pencere ve küçük sapma tetiklemez', () => {
      expect(severityOf(arrivalSignals({ distanceTrendMeters: 1500 }), 'SAFETY-R09')).toBe(
        'WARNING',
      );
      expect(ids(arrivalSignals({ distanceTrendMeters: 400 }))).not.toContain('SAFETY-R09');
      expect(
        ids(arrivalSignals({ distanceTrendMeters: 1500, recentWindowSeconds: 300 })),
      ).not.toContain('SAFETY-R09');
    });
  });

  describe('SAFETY-R10 — check-in tutarsızlığı (v2)', () => {
    const checkedInOutside = (overrides: Partial<SafetySignals> = {}) =>
      activeSignals({
        activationGeofenceState: 'OUTSIDE',
        geofenceState: 'OUTSIDE',
        geofenceStateSeconds: 60,
        geofenceEvidenceSide: 'OUTSIDE',
        geofenceEvidenceAgeSeconds: 30,
        ...overrides,
      });

    it('check-in sonrası hâlâ gelinmediyse WARNING', () => {
      expect(severityOf(checkedInOutside(), 'SAFETY-R10')).toBe('WARNING');
    });

    it('debounce gecikmesi: check-in sonrası içeri girildiyse tetiklemez', () => {
      expect(
        ids(checkedInOutside({ geofenceState: 'INSIDE', geofenceEvidenceSide: 'INSIDE' })),
      ).not.toContain('SAFETY-R10');
    });

    it("check-in'den hemen sonra (tolerans içinde) tetiklemez", () => {
      expect(
        ids(checkedInOutside({ activatedAt: new Date('2026-10-05T11:58:00.000Z') })),
      ).not.toContain('SAFETY-R10');
    });

    it('belirsiz check-in durumu tetiklemez', () => {
      expect(
        ids(checkedInOutside({ activationGeofenceState: 'INSUFFICIENT_ACCURACY' })),
      ).not.toContain('SAFETY-R10');
    });
  });

  it('birden fazla kural birlikte tetiklenir ve sıra sabittir', () => {
    const signals = activeSignals({
      geofenceState: 'OUTSIDE',
      geofenceStateSeconds: 400,
      geofenceEvidenceSide: 'OUTSIDE',
      secondsSinceTelemetry: 700,
      mockLocationCount: 2,
    });

    expect(ids(signals)).toEqual(['SAFETY-R02', 'SAFETY-R03', 'SAFETY-R06']);
    expect(evaluateRules(signals)).toEqual(evaluateRules(signals));
  });

  it('kurallar varsayılan eşiklerle aynı sonucu verir (sürüm sabit)', () => {
    const signals = activeSignals({ secondsSinceTelemetry: 700 });

    expect(evaluateRules(signals, DEFAULT_RULE_THRESHOLDS)).toEqual(evaluateRules(signals));
  });
});
