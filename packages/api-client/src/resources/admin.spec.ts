import { vi } from 'vitest';
import { createApiClient } from '../client';
import { adminApi } from './admin';

function client() {
  const fetchMock = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
  const api = adminApi(
    createApiClient({ getIdToken: async () => 'tok', fetch: fetchMock as unknown as typeof fetch }),
  );
  const last = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    return { url, init, headers: new Headers(init.headers), body: init.body as string | undefined };
  };
  return { api, last };
}

describe('adminApi', () => {
  it('liste sorgusu cursor/filtreyi taşır; boş filtre gönderilmez', async () => {
    const { api, last } = client();
    await api.bookings.list({ status: 'DISPUTED', cursor: 'abc=', customerId: undefined });
    expect(last().url).toBe('/api/v1/bookings/admin?status=DISPUTED&cursor=abc%3D');
  });

  it("boolean filtreler backend'in beklediği 'true'/'false' metnine çevrilir", async () => {
    const { api, last } = client();
    await api.ops.deadLetters({ resolved: false });
    expect(last().url).toBe('/api/v1/ops/dead-letter?resolved=false');
    await api.analytics.discrepancies({ resolved: true, discrepancyType: 'STUCK_PENDING_COMMAND' });
    expect(last().url).toBe(
      '/api/v1/analytics/reconciliation?resolved=true&discrepancyType=STUCK_PENDING_COMMAND',
    );
  });

  it('para hareketleri çağıranın Idempotency-Key’iyle gider', async () => {
    const { api, last } = client();
    await api.payments.release('p/1', 'k-rel');
    expect(last().url).toBe('/api/v1/payments/p%2F1/release');
    expect(last().headers.get('Idempotency-Key')).toBe('k-rel');
    await api.payments.refund('p1', { reason: 'Hizmet yapılmadı', amountMinor: '5000' }, 'k-ref');
    expect(JSON.parse(last().body!)).toEqual({ reason: 'Hizmet yapılmadı', amountMinor: '5000' });
    expect(last().headers.get('Idempotency-Key')).toBe('k-ref');
  });

  it('kurtarma onayında gerekçe boşsa gövdeye yazılmaz', async () => {
    const { api, last } = client();
    await api.recovery.approve('r1', undefined, 'k');
    expect(last().body).toBe('{}');
    await api.recovery.approve('r1', 'Belge eşleşti', 'k2');
    expect(JSON.parse(last().body!)).toEqual({ reason: 'Belge eşleşti' });
  });

  it('ham konum okuması gerekçe ve cam kırma beyanını sorguda taşır', async () => {
    const { api, last } = client();
    await api.safety.locations('s1', { reason: 'Panik incelemesi', breakGlass: false });
    expect(last().url).toBe(
      '/api/v1/safety/operator/sessions/s1/locations?reason=Panik+incelemesi&breakGlass=false',
    );
    expect(last().init.method).toBe('GET');
  });
});
