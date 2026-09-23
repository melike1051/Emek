import { BigQueryClientAdapter } from './bigquery-client.adapter';
import type { BigQuery, Table } from '@google-cloud/bigquery';
import { BigQueryPortError } from './bigquery.port';
import type { AnalyticsEventRow } from './bigquery.port';

describe('BigQueryClientAdapter', () => {
  let adapter: BigQueryClientAdapter;
  let mockTable: jest.Mocked<Table>;
  let client: jest.Mocked<BigQuery>;

  const row: AnalyticsEventRow = {
    eventId: 'evt-1',
    eventType: 'BookingCreated',
    eventVersion: 1,
    aggregateType: 'Booking',
    aggregateId: 'b-1',
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    correlationId: null,
    payload: { bookingId: 'b-1' },
  };

  beforeEach(() => {
    mockTable = { insert: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<Table>;
    client = {
      dataset: jest.fn().mockReturnValue({ table: jest.fn().mockReturnValue(mockTable) }),
    } as unknown as jest.Mocked<BigQuery>;
    adapter = new BigQueryClientAdapter(client, 'emek_analytics');
  });

  it('boş satır listesinde hiçbir şey göndermez', async () => {
    const result = await adapter.insertRows('raw_events', []);
    expect(result.rejectedEventIds).toEqual([]);
    expect(mockTable.insert).not.toHaveBeenCalled();
  });

  it('her satır insertId=eventId ile gönderilir (idempotency)', async () => {
    await adapter.insertRows('raw_events', [row]);

    const [payload, options] = mockTable.insert.mock.calls[0] as [unknown, unknown];
    expect(options).toMatchObject({ raw: true });
    expect(payload).toEqual([
      expect.objectContaining({
        insertId: 'evt-1',
        json: expect.objectContaining({ event_id: 'evt-1', event_type: 'BookingCreated' }),
      }),
    ]);
  });

  it('PartialFailureError reddedilen satırları rejectedEventIds olarak döner (para/durum bozulmaz)', async () => {
    const partialFailure = Object.assign(new Error('partial failure'), {
      name: 'PartialFailureError',
      errors: [{ insertId: 'evt-1', errors: [{ reason: 'invalid' }] }],
    });
    (mockTable.insert as jest.Mock).mockRejectedValueOnce(partialFailure);

    const result = await adapter.insertRows('raw_events', [row]);
    expect(result.rejectedEventIds).toEqual(['evt-1']);
  });

  it('diğer hatalar BigQueryPortError olarak yeniden fırlatılır', async () => {
    (mockTable.insert as jest.Mock).mockRejectedValueOnce(new Error('network down'));

    await expect(adapter.insertRows('raw_events', [row])).rejects.toThrow(BigQueryPortError);
  });
});
