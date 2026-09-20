import type { Pool } from 'pg';
import { IdempotencyService } from './idempotency.service';

function createService(queryResults: unknown[][]): {
  service: IdempotencyService;
  query: jest.Mock;
} {
  const query = jest.fn();
  queryResults.forEach((rows) => query.mockResolvedValueOnce({ rows, rowCount: rows.length }));
  return { service: new IdempotencyService({ query } as unknown as Pool), query };
}

describe('IdempotencyService.fingerprint', () => {
  const { service } = createService([]);

  it('alan sırasından bağımsızdır', () => {
    expect(service.fingerprint({ a: 1, b: 2 })).toBe(service.fingerprint({ b: 2, a: 1 }));
  });

  it('değer değişince farklılaşır', () => {
    expect(service.fingerprint({ amount: 100 })).not.toBe(service.fingerprint({ amount: 101 }));
  });

  it('iç içe nesnelerde de sıradan bağımsızdır', () => {
    expect(service.fingerprint({ outer: { x: 1, y: 2 } })).toBe(
      service.fingerprint({ outer: { y: 2, x: 1 } }),
    );
  });

  it('dizi sırası anlamlıdır', () => {
    expect(service.fingerprint([1, 2])).not.toBe(service.fingerprint([2, 1]));
  });

  it('undefined alan parmak izini etkilemez', () => {
    expect(service.fingerprint({ a: 1, b: undefined })).toBe(service.fingerprint({ a: 1 }));
  });
});

describe('IdempotencyService.begin', () => {
  it('yeni anahtarda FIRST_REQUEST döner', async () => {
    const { service } = createService([[{ key: 'k1' }]]);

    await expect(service.begin('POST /x', 'k1', 'fp')).resolves.toEqual({
      outcome: 'FIRST_REQUEST',
    });
  });

  it('tamamlanmış aynı istekte saklanan yanıtı döner', async () => {
    const { service } = createService([
      [],
      [
        {
          request_fingerprint: 'fp',
          status: 'COMPLETED',
          response_status: 201,
          response_body: { id: 'x' },
        },
      ],
    ]);

    await expect(service.begin('POST /x', 'k1', 'fp')).resolves.toEqual({
      outcome: 'COMPLETED',
      response: { status: 201, body: { id: 'x' } },
    });
  });

  it('aynı anahtar farklı gövdeyle gelirse çakışma bildirir', async () => {
    const { service } = createService([
      [],
      [
        {
          request_fingerprint: 'other-fp',
          status: 'COMPLETED',
          response_status: 200,
          response_body: {},
        },
      ],
    ]);

    await expect(service.begin('POST /x', 'k1', 'fp')).resolves.toEqual({
      outcome: 'FINGERPRINT_MISMATCH',
    });
  });

  it('taze rezervasyon varken IN_PROGRESS döner (devralma yok)', async () => {
    const { service } = createService([
      [],
      [
        {
          request_fingerprint: 'fp',
          status: 'IN_PROGRESS',
          response_status: null,
          response_body: null,
        },
      ],
      [], // devralma UPDATE'i 0 satır etkiler: rezervasyon hâlâ taze
    ]);

    await expect(service.begin('POST /x', 'k1', 'fp')).resolves.toEqual({ outcome: 'IN_PROGRESS' });
  });

  // Süreç istek ortasında çökerse kayıt IN_PROGRESS kalır; kiralama süresi dolunca
  // istemci aynı anahtarla ilerleyebilmeli (aksi halde TTL boyunca kilitlenir).
  it('kiralama süresi dolmuş rezervasyon devralınır', async () => {
    const { service } = createService([
      [],
      [
        {
          request_fingerprint: 'fp',
          status: 'IN_PROGRESS',
          response_status: null,
          response_body: null,
        },
      ],
      [{ scope: 'POST /x' }], // devralma UPDATE'i 1 satır etkiledi
    ]);

    await expect(service.begin('POST /x', 'k1', 'fp')).resolves.toEqual({
      outcome: 'FIRST_REQUEST',
    });
  });

  it('kayıt araya giren temizlikle silinmişse yeni istek gibi davranır', async () => {
    const { service } = createService([[], []]);

    await expect(service.begin('POST /x', 'k1', 'fp')).resolves.toEqual({
      outcome: 'FIRST_REQUEST',
    });
  });
});
