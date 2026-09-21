import {
  TELEMETRY_MIN_SPACING_SECONDS,
  TELEMETRY_REANCHOR_AFTER,
  validateSample,
  type TelemetryPolicy,
  type TelemetrySample,
  type TelemetryState,
} from './telemetry-validator';

/**
 * Telemetri doğrulayıcı (ADR-0008 §7, T-33).
 *
 * Telemetri güvenilmez istemci girdisidir; bu testler istemcinin **yalan
 * söyleyebileceği** her boyutu tek tek dener: sıra, zaman ve konum.
 */
describe('validateSample', () => {
  const now = new Date('2026-10-05T10:00:00.000Z');
  const policy: TelemetryPolicy = {
    maxSkewSeconds: 120,
    maxAgeSeconds: 900,
    maxSpeedMps: 60,
    minSpacingSeconds: TELEMETRY_MIN_SPACING_SECONDS,
    reanchorAfter: TELEMETRY_REANCHOR_AFTER,
  };

  const fresh: TelemetryState = {
    lastSequence: 0,
    lastCapturedAt: null,
    lastLatitude: null,
    lastLongitude: null,
    lastAccuracyMeters: null,
    consecutiveSpeedRejections: 0,
    monitoringStartedAt: new Date('2026-10-05T09:30:00.000Z'),
  };

  function sample(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
    return {
      sequence: 1,
      capturedAt: new Date(now.getTime() - 10_000),
      latitude: 41.0,
      longitude: 29.0,
      accuracyMeters: 10,
      speedMps: null,
      headingDegrees: null,
      isMockLocation: false,
      ...overrides,
    };
  }

  function after(state: TelemetryState, first: TelemetrySample): TelemetryState {
    const step = validateSample(state, first, now, policy);
    expect(step.result.verdict).toBe('ACCEPTED');
    return step.next;
  }

  it('geçerli örneği kabul eder ve çapayı günceller', () => {
    const step = validateSample(fresh, sample(), now, policy);

    expect(step.result).toEqual({ verdict: 'ACCEPTED', reanchored: false });
    expect(step.next.lastSequence).toBe(1);
    expect(step.next.lastLatitude).toBe(41.0);
  });

  it('aynı sıra numarası (tekrar/replay) durumu değiştirmeden reddedilir', () => {
    const state = after(fresh, sample());

    const replay = validateSample(state, sample({ latitude: 42 }), now, policy);

    expect(replay.result).toEqual({ verdict: 'REJECTED', reason: 'SEQUENCE_REPLAY' });
    expect(replay.next).toBe(state);
  });

  it('geri giden sıra numarası reddedilir', () => {
    const state = after(fresh, sample({ sequence: 10 }));

    expect(validateSample(state, sample({ sequence: 9 }), now, policy).result).toEqual({
      verdict: 'REJECTED',
      reason: 'SEQUENCE_REPLAY',
    });
  });

  it('geleceğe tarihli örnek reddedilir (saat sapması)', () => {
    const step = validateSample(
      fresh,
      sample({ capturedAt: new Date(now.getTime() + 121_000) }),
      now,
      policy,
    );

    expect(step.result).toEqual({ verdict: 'REJECTED', reason: 'CLOCK_SKEW_FUTURE' });
    // Ret de sıra numarasını tüketir: aynı numarayla düzeltilmiş ikinci gönderim olmaz.
    expect(step.next.lastSequence).toBe(1);
  });

  it('tolerans içindeki ileri saat kabul edilir', () => {
    const step = validateSample(
      fresh,
      sample({ capturedAt: new Date(now.getTime() + 60_000) }),
      now,
      policy,
    );

    expect(step.result.verdict).toBe('ACCEPTED');
  });

  it('gecikmeli teslim penceresinden eski örnek bayattır', () => {
    const step = validateSample(
      fresh,
      sample({ capturedAt: new Date(now.getTime() - 901_000) }),
      now,
      policy,
    );

    expect(step.result).toEqual({ verdict: 'REJECTED', reason: 'CLOCK_SKEW_STALE' });
  });

  it('cihaz uykusundan sonra gelen gecikmeli (pencere içi) örnek kabul edilir', () => {
    const step = validateSample(
      fresh,
      sample({ capturedAt: new Date(now.getTime() - 600_000) }),
      now,
      policy,
    );

    expect(step.result.verdict).toBe('ACCEPTED');
  });

  it('izleme başlamadan önce alınmış örnek amaç sınırlaması gereği reddedilir', () => {
    const state = { ...fresh, monitoringStartedAt: new Date(now.getTime() - 60_000) };

    const step = validateSample(
      state,
      sample({ capturedAt: new Date(now.getTime() - 300_000) }),
      now,
      policy,
    );

    expect(step.result).toEqual({ verdict: 'REJECTED', reason: 'CAPTURED_BEFORE_SESSION' });
  });

  it('sıra ilerleyip zaman geri giderse saat manipülasyonu sayılır', () => {
    const state = after(fresh, sample({ capturedAt: new Date(now.getTime() - 10_000) }));

    const step = validateSample(
      state,
      sample({ sequence: 2, capturedAt: new Date(now.getTime() - 60_000) }),
      now,
      policy,
    );

    expect(step.result).toEqual({ verdict: 'REJECTED', reason: 'CLOCK_REGRESSION' });
  });

  it('asgari aralığın altındaki örnek taşma olarak reddedilir', () => {
    const state = after(fresh, sample({ capturedAt: new Date(now.getTime() - 10_000) }));

    const step = validateSample(
      state,
      sample({ sequence: 2, capturedAt: new Date(now.getTime() - 8_000) }),
      now,
      policy,
    );

    expect(step.result).toEqual({ verdict: 'REJECTED', reason: 'TOO_FREQUENT' });
  });

  it('imkânsız hızdaki sıçrama reddedilir ve çapa değişmez', () => {
    const state = after(fresh, sample({ capturedAt: new Date(now.getTime() - 60_000) }));

    // ~11 km / 50 sn ≈ 220 m/sn.
    const step = validateSample(
      state,
      sample({ sequence: 2, latitude: 41.1, capturedAt: new Date(now.getTime() - 10_000) }),
      now,
      policy,
    );

    expect(step.result).toEqual({ verdict: 'REJECTED', reason: 'IMPOSSIBLE_SPEED' });
    expect(step.next.lastLatitude).toBe(41.0);
    expect(step.next.consecutiveSpeedRejections).toBe(1);
  });

  it('GPS jitter (doğruluk daireleri kesişiyor) imkânsız hız sayılmaz', () => {
    const state = after(
      fresh,
      sample({ accuracyMeters: 80, capturedAt: new Date(now.getTime() - 15_000) }),
    );

    // ~150 m sıçrama 5 sn'de (30 m/sn ham) ama iki 80 m'lik daire kesişiyor.
    const step = validateSample(
      state,
      sample({
        sequence: 2,
        latitude: 41.00135,
        accuracyMeters: 80,
        capturedAt: new Date(now.getTime() - 10_000),
      }),
      now,
      policy,
    );

    expect(step.result.verdict).toBe('ACCEPTED');
  });

  it('hatalı çapadan sonra tutarlı yeni konum ardışık retlerden sonra çapa olur', () => {
    // İlk örnek yanlış (cihazın bayat konumu); sonraki doğru örnekler ondan 11 km uzakta.
    let state = after(fresh, sample({ capturedAt: new Date(now.getTime() - 120_000) }));

    const verdicts: string[] = [];
    let reanchored = false;
    for (let index = 0; index < TELEMETRY_REANCHOR_AFTER; index += 1) {
      const step = validateSample(
        state,
        sample({
          sequence: 2 + index,
          latitude: 41.1,
          capturedAt: new Date(now.getTime() - 110_000 + index * 10_000),
        }),
        now,
        policy,
      );
      state = step.next;
      verdicts.push(step.result.verdict);
      if (step.result.verdict === 'ACCEPTED') {
        reanchored = step.result.reanchored;
      }
    }

    expect(verdicts).toEqual(['REJECTED', 'REJECTED', 'ACCEPTED']);
    expect(reanchored).toBe(true);
    expect(state.lastLatitude).toBe(41.1);
    expect(state.consecutiveSpeedRejections).toBe(0);
  });

  it('aynı girdi aynı kararı verir (determinizm)', () => {
    const input = sample();

    expect(validateSample(fresh, input, now, policy)).toEqual(
      validateSample(fresh, input, now, policy),
    );
  });
});
