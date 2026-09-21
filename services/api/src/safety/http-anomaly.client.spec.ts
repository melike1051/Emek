import type { AnomalyFeatures } from './anomaly.port';
import { HttpAnomalyClient, toAssessment } from './http-anomaly.client';

/**
 * Anomali istemcisi sözleşmesi (Faz 7 matching istemcisiyle aynı disiplin).
 *
 * Ölçülen şey: model **beklenmedik** davrandığında core'un ne yaptığı. Hiçbir
 * durumda hata yükseltilmez; her bozulma sınıflandırılmış bir `UNAVAILABLE` olur ve
 * değerlendirme deterministik kurallarla devam eder.
 */
describe('HttpAnomalyClient', () => {
  const config = {
    env: { AI_SERVICE_URL: 'http://ai.local', SAFETY_ANOMALY_TIMEOUT_MS: 50 },
  } as never;
  const logger = { warn: jest.fn(), error: jest.fn() } as never;

  function clientWith(fetchImpl: typeof fetch): HttpAnomalyClient {
    global.fetch = fetchImpl;
    return new HttpAnomalyClient(config, logger);
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const features: AnomalyFeatures = {
    sessionStatus: 'ARRIVAL_MONITORING',
    telemetryIntervalSeconds: 30,
    plannedDurationSeconds: 7200,
    arrivalDelaySeconds: -600,
    elapsedActiveSeconds: null,
    geofenceState: 'OUTSIDE',
    geofenceStateSeconds: 300,
    secondsSinceTelemetry: 30,
    telemetryCount: 10,
    rejectedCount: 0,
    integrityRejectionCount: 0,
    mockLocationCount: 0,
    lastDistanceMeters: 2000,
    recentMovementMeters: 900,
    recentWindowSeconds: 600,
    distanceTrendMeters: -900,
    recentLongGapCount: 0,
    recentExitCount: 0,
    route: {
      origin: { latitude: 41, longitude: 29 },
      destination: { latitude: 41.01, longitude: 29.01 },
    },
  };

  const validBody = {
    model_version: 'anomaly-deviation-v1',
    anomaly_score: 0.31,
    quality: 1,
    contributions: [{ feature: 'arrival_delay', deviation: 0.2, contribution: 0.12 }],
    unavailable_features: [],
    route: { available: true, provider: 'haversine', eta_seconds: 420, distance_meters: 2100 },
  };

  it('geçerli yanıtı sürümüyle ve rotasıyla döndürür (sürüm yayılımı)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(validBody));
    const outcome = await clientWith(fetchMock).assess(features);

    expect(outcome).toEqual({
      status: 'ASSESSED',
      assessment: {
        anomalyScore: 0.31,
        modelVersion: 'anomaly-deviation-v1',
        quality: 1,
        contributions: [{ feature: 'arrival_delay', contribution: 0.12 }],
        unavailableFeatures: [],
        route: { etaSeconds: 420, distanceMeters: 2100, provider: 'haversine' },
      },
    });

    // Sözleşme snake_case ve yalnızca türetilmiş sinyaller + iki nokta taşır.
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.session_status).toBe('ARRIVAL_MONITORING');
    expect(Object.keys(body)).not.toContain('sessionId');
  });

  it('sürümsüz ya da aralık dışı skor reddedilir (INVALID_RESPONSE)', async () => {
    for (const body of [
      { ...validBody, model_version: '' },
      { ...validBody, anomaly_score: 1.5 },
      { ...validBody, quality: -0.1 },
      { ...validBody, anomaly_score: 'high' },
    ]) {
      await expect(
        clientWith(jest.fn().mockResolvedValue(jsonResponse(body))).assess(features),
      ).resolves.toEqual({ status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' });
    }
  });

  it('JSON olmayan gövde bozuk yanıttır, taşıma hatası değil', async () => {
    const response = new Response('<html>oops</html>', { status: 200 });

    await expect(
      clientWith(jest.fn().mockResolvedValue(response)).assess(features),
    ).resolves.toEqual({ status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' });
  });

  it('4xx sözleşme uyuşmazlığıdır, kesinti değil', async () => {
    await expect(
      clientWith(jest.fn().mockResolvedValue(jsonResponse({ detail: 'x' }, 422))).assess(features),
    ).resolves.toEqual({ status: 'UNAVAILABLE', reason: 'CONTRACT_MISMATCH' });
  });

  it('5xx işletme hatasıdır', async () => {
    await expect(
      clientWith(jest.fn().mockResolvedValue(jsonResponse({}, 503))).assess(features),
    ).resolves.toEqual({ status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' });
  });

  it('zaman aşımı TIMEOUT olarak sınıflanır', async () => {
    const hanging = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );

    await expect(clientWith(hanging as unknown as typeof fetch).assess(features)).resolves.toEqual({
      status: 'UNAVAILABLE',
      reason: 'TIMEOUT',
    });
  });

  it('bağlantı hatası TRANSPORT olarak sınıflanır', async () => {
    await expect(
      clientWith(jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))).assess(features),
    ).resolves.toEqual({ status: 'UNAVAILABLE', reason: 'TRANSPORT' });
  });
});

describe('toAssessment', () => {
  const base = {
    model_version: 'anomaly-deviation-v1',
    anomaly_score: 0.5,
    quality: 0.8,
  };

  it('bozuk rota "rota yok" sayılır, bozuk hâliyle kullanılmaz', () => {
    expect(
      toAssessment({ ...base, route: { available: true, eta_seconds: -5 } })?.route,
    ).toBeNull();
    expect(
      toAssessment({
        ...base,
        route: { available: true, provider: 'x', eta_seconds: 10 * 24 * 3600, distance_meters: 1 },
      })?.route,
    ).toBeNull();
    expect(toAssessment({ ...base, route: { available: false } })?.route).toBeNull();
  });

  it('bozuk katkı satırı düşer, geçerli olanlar kalır', () => {
    const assessment = toAssessment({
      ...base,
      contributions: [
        { feature: 'telemetry_gap', contribution: 0.4 },
        { feature: '', contribution: 0.1 },
        { feature: 'x', contribution: 7 },
        'junk',
      ],
    });

    expect(assessment?.contributions).toEqual([{ feature: 'telemetry_gap', contribution: 0.4 }]);
  });
});
