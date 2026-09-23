import { clampLimit, decodeCursor, encodeCursor, paginate } from './cursor';

describe('cursor pagination', () => {
  it('round-trips a cursor through encode/decode', () => {
    const cursor = { createdAt: new Date('2026-01-01T00:00:00.000Z'), id: 'abc-123' };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded).toEqual(cursor);
  });

  it('rejects malformed cursors instead of throwing', () => {
    expect(decodeCursor('not-base64-or-valid')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(Buffer.from('missing-separator').toString('base64'))).toBeNull();
    expect(decodeCursor(Buffer.from('not-a-date|id').toString('base64'))).toBeNull();
  });

  it('clamps limit into the safe range', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(50);
    expect(clampLimit(-5)).toBe(50);
    expect(clampLimit(9999)).toBe(200);
    expect(clampLimit(10)).toBe(10);
  });

  it('paginate() cuts the lookahead row and encodes the next cursor', () => {
    const rows = [
      { id: '1', createdAt: new Date('2026-01-03T00:00:00.000Z') },
      { id: '2', createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { id: '3', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ];

    const page = paginate(rows, 2, (row) => ({ createdAt: row.createdAt, id: row.id }));
    expect(page.items).toHaveLength(2);
    expect(page.items.map((r) => r.id)).toEqual(['1', '2']);
    expect(page.nextCursor).toBe(encodeCursor({ createdAt: rows[1]!.createdAt, id: '2' }));
  });

  it('paginate() returns a null cursor when there is no further page', () => {
    const rows = [{ id: '1', createdAt: new Date() }];
    const page = paginate(rows, 5, (row) => ({ createdAt: row.createdAt, id: row.id }));
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});
