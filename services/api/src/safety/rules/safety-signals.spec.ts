import { buildSignals, summarizeTrace, withRoute, type SignalSource } from './safety-signals';

describe('summarizeTrace', () => {
  const start = new Date('2026-10-05T11:00:00.000Z').getTime();

  function at(seconds: number, latitude: number, accuracy = 10, distance = 0) {
    return {
      capturedAt: new Date(start + seconds * 1000),
      latitude,
      longitude: 29,
      accuracyMeters: accuracy,
      distanceToServiceMeters: distance,
    };
  }

  it('tek örnekle özet üretilmez (yetersiz iz)', () => {
    expect(summarizeTrace([at(0, 41)], 150)).toBeNull();
  });

  it("masada duran telefonun jitter'ı hareket sayılmaz", () => {
    // ±~10 m zıplama, 30 m doğrulukla.
    const samples = Array.from({ length: 20 }, (_, index) =>
      at(index * 60, 41 + (index % 2 === 0 ? 0 : 0.0001), 30),
    );

    expect(summarizeTrace(samples, 150)?.movementMeters).toBe(0);
  });

  it('gerçek hareket ölçülür ve sıra istemci zamanına göre kurulur', () => {
    // Sırasız gelen (tamponlanmış) örnekler.
    const samples = [at(120, 41.002), at(0, 41.0), at(60, 41.001)];

    const summary = summarizeTrace(samples, 150);

    expect(summary?.spanSeconds).toBe(120);
    expect(summary?.movementMeters).toBeGreaterThan(150);
    expect(summary?.movementMeters).toBeLessThan(250);
  });

  it('uzun boşlukları ve içeriden dışarıya çıkışları sayar; yaklaşma çıkış değildir', () => {
    const samples = [
      // Yaklaşma: dışarıda ama henüz hiç içeride görülmedi.
      at(0, 41, 10, 900),
      at(30, 41, 10, 600),
      // İçeri girdi.
      at(60, 41, 10, 20),
      at(90, 41, 10, 20),
      // 6 dk boşluk, sonra çıkış (iki kesin dışarıda örnek).
      at(450, 41, 10, 400),
      at(480, 41, 10, 400),
      at(510, 41, 10, 20),
      // Tek dışarıda örnek çıkış sayılmaz (jitter).
      at(540, 41, 10, 400),
      at(570, 41, 10, 20),
    ];

    const summary = summarizeTrace(samples, 150);

    expect(summary?.longGapCount).toBe(1);
    expect(summary?.exitCount).toBe(1);
  });

  it('hareket son 30 dakikadan ölçülür: takılmadan önceki sürüş hareketi şişirmez', () => {
    // 0-20 dk: sürüş (her dakika ~110 m); 20-60 dk: tamamen duruyor.
    const samples = [
      ...Array.from({ length: 20 }, (_, minute) => at(minute * 60, 41 + minute * 0.001)),
      ...Array.from({ length: 41 }, (_, minute) => at((20 + minute) * 60, 41.02)),
    ];

    const summary = summarizeTrace(samples, 150);

    expect(summary?.movementMeters).toBe(0);
    expect(summary?.spanSeconds).toBe(30 * 60);
  });

  it('hizmet noktasına mesafe eğilimi (pozitif = uzaklaşıyor)', () => {
    const summary = summarizeTrace([at(0, 41, 10, 500), at(600, 41.01, 10, 1800)], 150);

    expect(summary?.distanceTrendMeters).toBe(1300);
  });
});

describe('buildSignals', () => {
  const now = new Date('2026-10-05T12:00:00.000Z');
  const source: SignalSource = {
    status: 'ARRIVAL_MONITORING',
    scheduledStart: new Date('2026-10-05T12:30:00.000Z'),
    scheduledEnd: new Date('2026-10-05T14:30:00.000Z'),
    telemetryIntervalSeconds: 30,
    geofenceRadiusMeters: 150,
    monitoringStartedAt: new Date('2026-10-05T11:40:00.000Z'),
    activatedAt: null,
    activationGeofenceState: null,
    geofenceState: 'UNKNOWN',
    geofenceStateSince: null,
    lastDistanceMeters: null,
    lastTelemetryAt: null,
    telemetryCount: 0,
    rejectedCount: 0,
    integrityRejectionCount: 0,
    mockLocationCount: 0,
  };

  it('hiç telemetri yoksa boşluk izlemenin başladığı andan ölçülür ve eksik işaretlenir', () => {
    const signals = buildSignals(source, null, now);

    expect(signals.secondsSinceTelemetry).toBe(20 * 60);
    expect(signals.unavailable).toEqual(
      expect.arrayContaining(['telemetry', 'geofence', 'trace', 'route']),
    );
  });

  it('rota gelirse eksik listesinden çıkar; gelmezse uydurulmaz', () => {
    const signals = buildSignals(source, null, now);

    expect(withRoute(signals, null).routeEtaSeconds).toBeNull();
    const routed = withRoute(signals, { etaSeconds: 900, provider: 'haversine' });
    expect(routed.routeEtaSeconds).toBe(900);
    expect(routed.unavailable).not.toContain('route');
  });

  it('aktif hizmette rota "eksik" sayılmaz (uygulanamaz)', () => {
    const signals = buildSignals(
      { ...source, status: 'ACTIVE', activatedAt: new Date('2026-10-05T11:50:00.000Z') },
      null,
      now,
    );

    expect(signals.unavailable).not.toContain('route');
  });
});
