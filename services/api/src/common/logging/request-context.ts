import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** Sunucu tarafından üretilir; istemci etkileyemez (audit izi ADR-0013'e bağlı). */
  requestId: string;
  /** İstemcinin gönderdiği izleme kimliği — yalnızca bilgi amaçlı, korelasyon kimliği değil. */
  clientTraceId?: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * İstek bağlamına kullanıcı kimliğini ekler (auth katmanı Faz 2'de çağırır).
 * Bağlam yoksa sessizce yok sayılır — logging asla istek akışını düşürmez.
 */
export function setRequestUser(userId: string): void {
  const context = storage.getStore();
  if (context) {
    context.userId = userId;
  }
}
