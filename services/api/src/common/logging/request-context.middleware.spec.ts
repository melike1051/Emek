import type { NextFunction, Request, Response } from 'express';
import { getRequestContext } from './request-context';
import {
  CLIENT_TRACE_HEADER,
  REQUEST_ID_HEADER,
  RequestContextMiddleware,
} from './request-context.middleware';

function createRequest(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function createResponse(): { res: Response; headers: Record<string, unknown> } {
  const headers: Record<string, unknown> = {};
  const res = {
    setHeader: (name: string, value: unknown) => {
      headers[name] = value;
    },
  } as unknown as Response;

  return { res, headers };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('RequestContextMiddleware', () => {
  const middleware = new RequestContextMiddleware();

  function capture(headers?: Record<string, string>) {
    const { res, headers: responseHeaders } = createResponse();
    let context: ReturnType<typeof getRequestContext>;

    middleware.use(createRequest(headers), res, (() => {
      context = getRequestContext();
    }) as NextFunction);

    return { context, responseHeaders };
  }

  it('her istek için sunucuda request id üretir ve yanıt başlığına yazar', () => {
    const { context, responseHeaders } = capture();

    expect(context?.requestId).toMatch(UUID);
    expect(responseHeaders[REQUEST_ID_HEADER]).toBe(context?.requestId);
  });

  it('ardışık isteklere farklı id verir', () => {
    expect(capture().context?.requestId).not.toBe(capture().context?.requestId);
  });

  // ADR-0013: audit izi istemci tarafından yönlendirilemez.
  it('istemcinin gönderdiği request id korelasyon kimliği olarak kullanılmaz', () => {
    const { context, responseHeaders } = capture({
      [REQUEST_ID_HEADER]: 'someone-elses-request-id',
    });

    expect(context?.requestId).toMatch(UUID);
    expect(context?.requestId).not.toBe('someone-elses-request-id');
    expect(responseHeaders[REQUEST_ID_HEADER]).not.toBe('someone-elses-request-id');
    // Gönderilen değer yalnızca bilgi amaçlı taşınır.
    expect(context?.clientTraceId).toBe('someone-elses-request-id');
  });

  it('istemci izleme kimliğini ayrı başlıktan da alır', () => {
    const { context } = capture({ [CLIENT_TRACE_HEADER]: 'client-trace-9' });

    expect(context?.clientTraceId).toBe('client-trace-9');
  });

  it('kötü biçimli istemci izleme kimliği taşınmaz (log injection engeli)', () => {
    const { context } = capture({ [CLIENT_TRACE_HEADER]: 'bad\nid "injected"' });

    expect(context?.clientTraceId).toBeUndefined();
    expect(context?.requestId).toMatch(UUID);
  });

  it('aşırı uzun istemci izleme kimliği taşınmaz', () => {
    const { context } = capture({ [CLIENT_TRACE_HEADER]: 'x'.repeat(200) });

    expect(context?.clientTraceId).toBeUndefined();
  });

  it('middleware dışında istek bağlamı sızmaz', () => {
    capture();

    expect(getRequestContext()).toBeUndefined();
  });
});
