import { HttpNlpClient } from './http-nlp.client';
import type { NlpParseOutcome } from './nlp.port';

/**
 * NLP istemcisi sözleşmesi.
 *
 * Ölçülen şey: AI servisi **beklenmedik** davrandığında core'un ne yaptığı. Yanıt
 * doğrulaması burada olmasaydı, iki servis sürümü ayrıştığında bozuk veri sessizce
 * `booking_requests` tablosuna yazılırdı.
 */
describe('HttpNlpClient', () => {
  const config = {
    env: { AI_SERVICE_URL: 'http://ai.local', AI_SERVICE_TIMEOUT_MS: 50 },
  } as never;
  const logger = { warn: jest.fn() } as never;

  function clientWith(fetchImpl: typeof fetch): HttpNlpClient {
    global.fetch = fetchImpl;
    return new HttpNlpClient(config, logger);
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const validBody = {
    status: 'PARSED',
    parser_version: 'heuristic-v1',
    confidence: 0.9,
    request: {
      service_type: 'standart-temizlik',
      duration_minutes: 180,
      service_date: '2026-04-10',
      time_window: { start_hour: 9, end_hour: 13 },
      requirements: ['utu'],
    },
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('geçerli yanıtı core sözleşmesine çevirir', async () => {
    const client = clientWith(async () => jsonResponse(validBody));

    const outcome = await client.parse({ rawText: 'temizlik' });

    expect(outcome).toEqual<NlpParseOutcome>({
      status: 'PARSED',
      parserVersion: 'heuristic-v1',
      confidence: 0.9,
      request: {
        serviceType: 'standart-temizlik',
        durationMinutes: 180,
        serviceDate: '2026-04-10',
        timeWindow: { startHour: 9, endHour: 13 },
        requirements: ['utu'],
      },
    });
  });

  it('bilinmeyen hizmet slugı reddedilir', async () => {
    // AI servisi yeni bir hizmet türü üretirse core onu katalogda aramaz.
    const client = clientWith(async () =>
      jsonResponse({
        ...validBody,
        request: { ...validBody.request, service_type: 'ev-boyama' },
      }),
    );

    const outcome = await client.parse({ rawText: 'boya' });

    expect(outcome).toEqual({ status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' });
  });

  it('aralık dışı süre reddedilir', async () => {
    const client = clientWith(async () =>
      jsonResponse({
        ...validBody,
        request: { ...validBody.request, duration_minutes: 5000 },
      }),
    );

    expect(await client.parse({ rawText: 'temizlik' })).toEqual({
      status: 'UNAVAILABLE',
      reason: 'INVALID_RESPONSE',
    });
  });

  it('parser sürümü olmayan yanıt reddedilir', async () => {
    // Sürümsüz çıktı kaydedilemez (ADR-0012 §1).
    const client = clientWith(async () => jsonResponse({ ...validBody, parser_version: '' }));

    expect(await client.parse({ rawText: 'temizlik' })).toEqual({
      status: 'UNAVAILABLE',
      reason: 'INVALID_RESPONSE',
    });
  });

  it('aralık dışı confidence reddedilir', async () => {
    const client = clientWith(async () => jsonResponse({ ...validBody, confidence: 1.4 }));

    expect(await client.parse({ rawText: 'temizlik' })).toEqual({
      status: 'UNAVAILABLE',
      reason: 'INVALID_RESPONSE',
    });
  });

  it('PARSED ama içi boş yanıt reddedilir', async () => {
    const client = clientWith(async () => jsonResponse({ ...validBody, request: null }));

    expect(await client.parse({ rawText: 'temizlik' })).toEqual({
      status: 'UNAVAILABLE',
      reason: 'INVALID_RESPONSE',
    });
  });

  it('bozuk saat aralığı yok sayılır ama talep düşmez', async () => {
    // Saat aralığı ikincil bilgidir: bozuksa atılır, tüm yanıt çöpe atılmaz.
    const client = clientWith(async () =>
      jsonResponse({
        ...validBody,
        request: { ...validBody.request, time_window: { start_hour: 18, end_hour: 9 } },
      }),
    );

    const outcome = await client.parse({ rawText: 'temizlik' });

    expect(outcome.status).toBe('PARSED');
    expect(outcome.status === 'PARSED' && outcome.request.timeWindow).toBeNull();
  });

  it('netleştirme yanıtı soru listesiyle döner', async () => {
    const client = clientWith(async () =>
      jsonResponse({
        status: 'NEEDS_CLARIFICATION',
        parser_version: 'heuristic-v1',
        confidence: 0.3,
        request: null,
        clarifications: [
          { field: 'service_type', question: 'Hangi hizmet?', options: ['Ev temizliği'] },
          // Bozuk giriş listeden düşer, diğerleri korunur.
          { question: 'eksik alan' },
        ],
      }),
    );

    const outcome = await client.parse({ rawText: 'merhaba' });

    expect(outcome.status).toBe('NEEDS_CLARIFICATION');
    expect(outcome.status === 'NEEDS_CLARIFICATION' && outcome.clarifications).toEqual([
      { field: 'service_type', question: 'Hangi hizmet?', options: ['Ev temizliği'] },
    ]);
  });

  it('HTTP hatası erişilemezlik sayılır', async () => {
    const client = clientWith(async () => jsonResponse({ detail: 'boom' }, 500));

    expect(await client.parse({ rawText: 'temizlik' })).toEqual({
      status: 'UNAVAILABLE',
      reason: 'INVALID_RESPONSE',
    });
  });

  it('ağ hatası istisna fırlatmaz', async () => {
    // NLP erişilemezliği bir iş hatası değildir: çağıran form yoluna düşer (T-15).
    const client = clientWith(async () => {
      throw new Error('ECONNREFUSED');
    });

    expect(await client.parse({ rawText: 'temizlik' })).toEqual({
      status: 'UNAVAILABLE',
      reason: 'TRANSPORT',
    });
  });

  it('süre aşımında TIMEOUT döner ve istek iptal edilir', async () => {
    const client = clientWith(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    expect(await client.parse({ rawText: 'temizlik' })).toEqual({
      status: 'UNAVAILABLE',
      reason: 'TIMEOUT',
    });
  });

  it('ham metin loglanmaz', async () => {
    // Kullanıcı talebi kişisel veri içerebilir.
    const warn = jest.fn();
    global.fetch = async () => {
      throw new Error('down');
    };
    const client = new HttpNlpClient(config, { warn } as never);

    await client.parse({ rawText: 'Ayşe hanımın evinde temizlik' });

    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('Ayşe');
    }
  });
});
