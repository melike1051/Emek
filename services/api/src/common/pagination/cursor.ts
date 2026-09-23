/**
 * Keyset (cursor) sayfalama kodlayıcısı.
 *
 * `OFFSET` yerine `(created_at, id)` üzerinden ilerlenir: büyüyen bir admin
 * listesinde OFFSET, sayfa ilerledikçe yavaşlar ve araya eklenen/silinen
 * satırlarla kayar. Cursor opak bir base64 dizesidir — istemci içeriğini
 * yorumlamaz, yalnızca bir sonraki sayfada geri gönderir.
 */
export interface ListCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64');
}

export function decodeCursor(value: string | undefined): ListCursor | null {
  if (value === undefined || value.length === 0) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf('|');
  if (separatorIndex === -1) {
    return null;
  }

  const isoTimestamp = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  const createdAt = new Date(isoTimestamp);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    return null;
  }

  return { createdAt, id };
}

export const DEFAULT_ADMIN_LIST_LIMIT = 50;
export const MAX_ADMIN_LIST_LIMIT = 200;

/** Sorgudan gelen `limit` değerini güvenli aralığa kırpar. */
export function clampLimit(
  limit: number | undefined,
  fallback = DEFAULT_ADMIN_LIST_LIMIT,
  max = MAX_ADMIN_LIST_LIMIT,
): number {
  if (limit === undefined || Number.isNaN(limit) || limit <= 0) {
    return fallback;
  }
  return Math.min(limit, max);
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: string | null;
}

/** `items` `limit + 1` satır sorgulanıp fazlası kesilerek üretilir; bu yardımcı o kesmeyi yapar. */
export function paginate<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => ListCursor,
): PagedResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null;
  return { items, nextCursor };
}
