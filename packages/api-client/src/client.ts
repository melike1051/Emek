import { ApiError, CLIENT_ERROR_CODES, isApiErrorBody } from './errors';

export const API_PREFIX = '/api/v1';

export interface ApiClientOptions {
  /**
   * Tarayıcıda boş bırakılır: istekler aynı-origin `/api/v1`'e gider ve Next.js proxy'si iletir
   * (ADR-0024 §5 — backend'de CORS yok). Sunucu tarafında mutlak origin verilir.
   */
  baseUrl?: string;
  /** Firebase ID token'ı (ADR-0016). `null` → anonim istek. */
  getIdToken: () => Promise<string | null>;
  /** Firebase App Check token'ı (ADR-0022). Kapalı ortamlarda `null`. */
  getAppCheckToken?: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** Test için enjekte edilebilir; varsayılan `crypto.randomUUID`. */
  generateIdempotencyKey?: () => string;
}

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  /**
   * Yan etkili komut için `Idempotency-Key` gönderir. `true` → yeni anahtar üretilir;
   * string → çağıran verir (aynı kullanıcı eyleminin yeniden denemesinde **aynı** anahtar
   * kullanılmalıdır, yoksa tekilleştirme işe yaramaz).
   */
  idempotencyKey?: string | true;
  signal?: AbortSignal;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiClient {
  request<T>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, options?: Omit<RequestOptions, 'body' | 'idempotencyKey'>): Promise<T>;
  post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'body'>): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'body'>): Promise<T>;
  delete<T>(path: string, options?: Omit<RequestOptions, 'body'>): Promise<T>;
}

/** `/bookings/{id}` gibi şablonlarda kullanılacak güvenli yol parçası. */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  if (!path.startsWith('/')) {
    throw new Error(`API yolu '/' ile başlamalı: ${path}`);
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      params.append(key, String(value));
    }
  }
  const search = params.toString();
  return `${baseUrl}${API_PREFIX}${path}${search ? `?${search}` : ''}`;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const newKey = options.generateIdempotencyKey ?? (() => crypto.randomUUID());

  async function request<T>(
    method: HttpMethod,
    path: string,
    init: RequestOptions = {},
  ): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });
    const [idToken, appCheckToken] = await Promise.all([
      options.getIdToken(),
      options.getAppCheckToken?.() ?? Promise.resolve(null),
    ]);
    if (idToken) {
      headers.set('Authorization', `Bearer ${idToken}`);
    }
    if (appCheckToken) {
      headers.set('X-Firebase-AppCheck', appCheckToken);
    }
    if (init.idempotencyKey !== undefined) {
      headers.set('Idempotency-Key', init.idempotencyKey === true ? newKey() : init.idempotencyKey);
    }
    let body: string | undefined;
    if (init.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(init.body);
    }

    let response: Response;
    try {
      response = await doFetch(buildUrl(baseUrl, path, init.query), {
        method,
        headers,
        body,
        signal: init.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw ApiError.client(CLIENT_ERROR_CODES.NETWORK);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw ApiError.client(CLIENT_ERROR_CODES.UNEXPECTED_RESPONSE, response.status);
      }
    }

    if (!response.ok) {
      if (isApiErrorBody(parsed)) {
        throw new ApiError(response.status, parsed.error);
      }
      throw ApiError.client(CLIENT_ERROR_CODES.UNEXPECTED_RESPONSE, response.status);
    }
    return parsed as T;
  }

  return {
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...opts, body }),
    patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
    delete: (path, opts) => request('DELETE', path, opts),
  };
}
