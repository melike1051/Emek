import { HttpMatchingClient } from './http-matching.client';
import type { MatchingDemand } from './matching.port';

/**
 * Matching istemcisi sözleşmesi.
 *
 * Ölçülen şey: karar motoru **beklenmedik** davrandığında core'un ne yaptığı.
 * Yanıt doğrulaması burada olmasaydı, iki servis sürümü ayrıştığında aralık dışı
 * bir skor veya sürümsüz bir karar doğrudan `booking_match_results` tablosuna
 * yazılmaya çalışılır ve istek çalışma zamanında patlardı.
 */
describe('HttpMatchingClient', () => {
  const config = {
    env: {
      AI_SERVICE_URL: 'http://ai.local',
      MATCHING_SERVICE_TIMEOUT_MS: 50,
      MATCHING_MAX_DISTANCE_METERS: 50000,
    },
  } as never;
  const logger = { warn: jest.fn(), error: jest.fn() } as never;

  function clientWith(fetchImpl: typeof fetch): HttpMatchingClient {
    global.fetch = fetchImpl;
    return new HttpMatchingClient(config, logger);
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const demand: MatchingDemand = {
    requestId: '00000000-0000-0000-0000-0000000003e8',
    serviceSlug: 'detayli-temizlik',
    durationMinutes: 180,
    window: {
      start: new Date('2026-10-05T06:00:00.000Z'),
      end: new Date('2026-10-05T14:00:00.000Z'),
    },
    location: { latitude: 41, longitude: 29 },
    requiredSkills: ['derin-temizlik'],
    preferredSkills: [],
    candidates: [],
  };

  const components = {
    skill_score: 1,
    availability_score: 1,
    quality_score: 0.9,
    distance_score: 0.96,
    rating_score: 0.88,
    preference_score: 1,
  };

  const validBody = {
    algorithm_version: 'matching-v1',
    weights_version: 'weights-v1',
    objective_version: 'objective-v1',
    strategy: 'OPTIMIZED',
    degraded: false,
    degraded_reason: null,
    routing_provider: 'haversine',
    rankings: [
      {
        request_id: demand.requestId,
        evaluated_count: 3,
        eliminated: [{ provider_id: 'x', violations: ['NOT_AVAILABLE'] }],
        candidates: [
          {
            provider_id: '00000000-0000-0000-0000-000000000001',
            rank: 1,
            components,
            overall_score: 0.83,
            explanation: [{ code: 'NEARBY', value: 1.2 }],
            distance_meters: 2000,
            travel_seconds: 312,
          },
        ],
      },
    ],
    assignments: [
      {
        request_id: demand.requestId,
        provider_id: '00000000-0000-0000-0000-000000000001',
        scheduled_start: '2026-10-05T06:00:00.000Z',
        scheduled_end: '2026-10-05T09:00:00.000Z',
        travel_seconds: 312,
        distance_meters: 2000,
        rank: 1,
      },
    ],
    constraint_violations: 0,
    optimization_runtime_ms: 42,
  };

  function solve(body: unknown, status = 200): Promise<unknown> {
    const client = clientWith(async () => jsonResponse(body, status));
    return client.solve({ demands: [demand], optimize: true });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('geçerli yanıtı core sözleşmesine çevirir', async () => {
    const outcome = await solve(validBody);

    expect(outcome).toMatchObject({
      status: 'SOLVED',
      solution: {
        algorithmVersion: 'matching-v1',
        weightsVersion: 'weights-v1',
        objectiveVersion: 'objective-v1',
        strategy: 'OPTIMIZED',
        degradedReason: null,
        routingProvider: 'haversine',
        constraintViolations: 0,
        optimizationRuntimeMs: 42,
      },
    });
  });

  it('elenen aday sayısını sayar ama kimliklerini taşımaz', async () => {
    const outcome = (await solve(validBody)) as {
      solution: { rankings: { eliminatedCount: number }[] };
    };

    expect(outcome.solution.rankings[0]?.eliminatedCount).toBe(1);
  });

  it('atama zaman damgalarını Date olarak çözer', async () => {
    const outcome = (await solve(validBody)) as {
      solution: { assignments: { scheduledStart: Date; scheduledEnd: Date }[] };
    };
    const assignment = outcome.solution.assignments[0];

    expect(assignment?.scheduledStart).toEqual(new Date('2026-10-05T06:00:00.000Z'));
    expect(assignment?.scheduledEnd).toEqual(new Date('2026-10-05T09:00:00.000Z'));
  });

  it('sürümsüz yanıtı reddeder', async () => {
    // Sürümsüz bir karar geriye dönük deney yapılmasını imkânsız kılar (ADR-0012 §1).
    const outcome = await solve({ ...validBody, algorithm_version: '' });

    expect(outcome).toEqual({ status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' });
  });

  it('ağırlık veya amaç sürümü eksik yanıtı reddeder', async () => {
    await expect(solve({ ...validBody, weights_version: undefined })).resolves.toEqual({
      status: 'UNAVAILABLE',
      reason: 'INVALID_RESPONSE',
    });
    await expect(solve({ ...validBody, objective_version: null })).resolves.toEqual({
      status: 'UNAVAILABLE',
      reason: 'INVALID_RESPONSE',
    });
  });

  it('bilinmeyen stratejiyi reddeder', async () => {
    const outcome = await solve({ ...validBody, strategy: 'MAGIC' });

    expect(outcome).toEqual({ status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' });
  });

  it('aralık dışı skoru reddeder', async () => {
    // Skor kolonunda CHECK var: aralık dışı değer yazıma kadar gitseydi istek
    // çalışma zamanında patlardı.
    const body = structuredClone(validBody);
    body.rankings[0]!.candidates[0]!.overall_score = 1.5;

    expect(await solve(body)).toEqual({ status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' });
  });

  it('aralık dışı bileşen skorunu reddeder', () => {
    const body = structuredClone(validBody);
    body.rankings[0]!.candidates[0]!.components.skill_score = -0.1;

    return expect(solve(body)).resolves.toEqual({
      status: 'UNAVAILABLE',
      reason: 'INVALID_RESPONSE',
    });
  });

  it('bitişi başlangıcından önce olan atamayı reddeder', async () => {
    const body = structuredClone(validBody);
    body.assignments[0]!.scheduled_end = '2026-10-05T05:00:00.000Z';

    expect(await solve(body)).toEqual({ status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' });
  });

  it('bilinmeyen bozulma nedenini null sayar', async () => {
    // Açıklanamayan bir neden kaydedilemez; sonuç yine de kullanılabilir.
    const outcome = (await solve({ ...validBody, degraded_reason: 'COSMIC_RAYS' })) as {
      solution: { degradedReason: string | null };
    };

    expect(outcome.solution.degradedReason).toBeNull();
  });

  it('bilinmeyen açıklama kodunu düşürür ama kararı geçersiz kılmaz', async () => {
    const body = structuredClone(validBody);
    body.rankings[0]!.candidates[0]!.explanation = [
      { code: 'NEARBY', value: 1.2 },
      { code: 42 as unknown as string, value: 0 },
    ];

    const outcome = (await solve(body)) as {
      status: string;
      solution: { rankings: { candidates: { explanation: unknown[] }[] }[] };
    };

    expect(outcome.status).toBe('SOLVED');
    expect(outcome.solution.rankings[0]?.candidates[0]?.explanation).toHaveLength(1);
  });

  it('5xx hatasını erişilemezlik olarak raporlar', async () => {
    expect(await solve(validBody, 500)).toEqual({
      status: 'UNAVAILABLE',
      reason: 'INVALID_RESPONSE',
    });
  });

  it('4xx hatasını sözleşme uyuşmazlığı olarak ayırt eder', async () => {
    // Bu bir kesinti değil, bir **hata**dır: motor isteği anlamadı. Kesintiyle aynı
    // kovaya konsaydı, unutulmuş bir şema güncellemesi "AI servisi kapalı" gibi
    // görünür ve sistem kalıcı olarak mesafeye göre eşleştirmeye düşerdi.
    expect(await solve({ detail: 'unknown service_type' }, 422)).toEqual({
      status: 'UNAVAILABLE',
      reason: 'CONTRACT_MISMATCH',
    });
  });

  it('ulaşılamayan servisi TRANSPORT olarak raporlar', async () => {
    const client = clientWith(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    expect(await client.solve({ demands: [demand], optimize: true })).toEqual({
      status: 'UNAVAILABLE',
      reason: 'TRANSPORT',
    });
  });

  it('zaman aşımını TIMEOUT olarak raporlar', async () => {
    const client = clientWith(
      (async (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        })) as unknown as typeof fetch,
    );

    expect(await client.solve({ demands: [demand], optimize: true })).toEqual({
      status: 'UNAVAILABLE',
      reason: 'TIMEOUT',
    });
  });

  // --- Devre kesici (Faz 14, EXP-007 S-11) ---

  it('art arda altyapı hatasından sonra devre açılır ve çağrı hiç yapılmaz', async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      throw new Error('connect ETIMEDOUT');
    });

    for (let i = 0; i < 5; i += 1) {
      expect(await client.solve({ demands: [demand], optimize: true }, 1000)).toEqual({
        status: 'UNAVAILABLE',
        reason: 'TRANSPORT',
      });
    }
    expect(calls).toBe(5);

    // Altıncı istek motora hiç gitmez: bekleme bedeli ödenmez.
    expect(await client.solve({ demands: [demand], optimize: true }, 1000)).toEqual({
      status: 'UNAVAILABLE',
      reason: 'CIRCUIT_OPEN',
    });
    expect(calls).toBe(5);
  });

  it('devre süresi dolunca **tek** bir deneme geçer, kapı açılmaz (gerçek yarı-açık)', async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      throw new Error('connect ETIMEDOUT');
    });

    for (let i = 0; i < 5; i += 1) {
      await client.solve({ demands: [demand], optimize: true }, 1000);
    }
    expect((await client.solve({ demands: [demand], optimize: true }, 1000)).status).toBe(
      'UNAVAILABLE',
    );
    expect(calls).toBe(5);

    // 30 sn sonra tek bir deneme yapılır: kesici kalıcı bir kapatma değildir.
    const probeAt = 1000 + 30_001;
    await client.solve({ demands: [demand], optimize: true }, probeAt);
    expect(calls).toBe(6);

    // Kritik ayrım: deneme düştüğüne göre kapı **yeniden kapanmış** olmalıdır.
    // Kapı serbest bırakılsaydı aşağıdaki istekler motora giderdi ve her biri tam
    // zaman aşımını öderdi — kesici, maliyeti 30 sn'de bir tekrarlanan bir sele
    // çevirmiş olurdu. Ayrıca yeniden kapanmak için 5 hata daha **gerekmez**.
    for (let i = 0; i < 3; i += 1) {
      expect(await client.solve({ demands: [demand], optimize: true }, probeAt + 1)).toEqual({
        status: 'UNAVAILABLE',
        reason: 'CIRCUIT_OPEN',
      });
    }
    expect(calls).toBe(6);
  });

  it('başarılı deneme devreyi kapatır: sonraki istekler normal akar', async () => {
    let calls = 0;
    let healthy = false;
    const client = clientWith(async () => {
      calls += 1;
      if (healthy) {
        return jsonResponse(validBody);
      }
      throw new Error('connect ETIMEDOUT');
    });

    for (let i = 0; i < 5; i += 1) {
      await client.solve({ demands: [demand], optimize: true }, 1000);
    }
    expect((await client.solve({ demands: [demand], optimize: true }, 1000)).status).toBe(
      'UNAVAILABLE',
    );

    healthy = true;
    const probeAt = 1000 + 30_001;
    expect((await client.solve({ demands: [demand], optimize: true }, probeAt)).status).toBe(
      'SOLVED',
    );

    // Deneme tuttu → devre kapandı; artık `CIRCUIT_OPEN` dönmemeli ve çağrı yapılmalı.
    const before = calls;
    expect((await client.solve({ demands: [demand], optimize: true }, probeAt + 1)).status).toBe(
      'SOLVED',
    );
    expect(calls).toBe(before + 1);
  });

  it('sözleşme hatası devreyi açmaz — şema ayrışması susturulmamalı', async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return jsonResponse({ detail: 'unknown service slug' }, 422);
    });

    for (let i = 0; i < 8; i += 1) {
      expect(await client.solve({ demands: [demand], optimize: true }, 1000)).toEqual({
        status: 'UNAVAILABLE',
        reason: 'CONTRACT_MISMATCH',
      });
    }
    expect(calls).toBe(8);
  });

  it('araya giren başarı sayacı sıfırlar — seyrek hatalar devreyi açmaz', async () => {
    let attempt = 0;
    const client = clientWith(async () => {
      attempt += 1;
      // 4 hata, 1 başarı, 4 hata: hiçbir noktada art arda 5 hata yok.
      if (attempt === 5) {
        return jsonResponse(validBody);
      }
      throw new Error('connect ETIMEDOUT');
    });

    for (let i = 0; i < 9; i += 1) {
      const outcome = await client.solve({ demands: [demand], optimize: true }, 1000);
      expect(outcome.status === 'UNAVAILABLE' ? outcome.reason : 'SOLVED').not.toBe('CIRCUIT_OPEN');
    }
    expect(attempt).toBe(9);
  });

  it('ham talep metnini veya konumu loglamaz', async () => {
    const warn = jest.fn();
    global.fetch = async () => {
      throw new Error('boom');
    };
    const client = new HttpMatchingClient(config, { warn } as never);

    await client.solve({ demands: [demand], optimize: true });

    expect(warn).toHaveBeenCalledWith({ reason: 'TRANSPORT' }, expect.any(String));
  });
});
