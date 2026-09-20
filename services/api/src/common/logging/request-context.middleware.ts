import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CLIENT_TRACE_HEADER = 'x-client-trace-id';

/** Bilgi amaçlı taşınan istemci izleme kimliği için güvenli biçim (log injection engeli). */
const SAFE_TRACE_ID = /^[A-Za-z0-9._-]{1,128}$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // requestId her zaman sunucuda üretilir: istemci başka bir isteğin kimliğiyle
    // çakışma üretip audit izini bulandıramaz (ADR-0013).
    const requestId = randomUUID();

    const incoming = req.header(REQUEST_ID_HEADER) ?? req.header(CLIENT_TRACE_HEADER);
    const clientTraceId =
      incoming !== undefined && SAFE_TRACE_ID.test(incoming) ? incoming : undefined;

    res.setHeader(REQUEST_ID_HEADER, requestId);
    runWithRequestContext(
      clientTraceId !== undefined ? { requestId, clientTraceId } : { requestId },
      () => next(),
    );
  }
}
