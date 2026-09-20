import { pino, type Logger } from 'pino';
import { maskSensitive } from './redact';
import { getRequestContext } from './request-context';

export interface LoggerOptions {
  level: string;
  pretty: boolean;
}

/** Her log satırı, varsa içinde bulunduğu isteğin bağlamını taşır. */
export function requestContextMixin(): Record<string, string> {
  const context = getRequestContext();
  if (!context) {
    return {};
  }
  return context.clientTraceId !== undefined
    ? { requestId: context.requestId, clientTraceId: context.clientTraceId }
    : { requestId: context.requestId };
}

export function createRootLogger({ level, pretty }: LoggerOptions): Logger {
  return pino({
    level,
    formatters: {
      level: (label) => ({ level: label }),
      // Hassas alanlar iç içe nesnelerde de maskelenir (pino redact tek seviye eşler).
      log: (object) => maskSensitive(object) as Record<string, unknown>,
    },
    mixin: requestContextMixin,
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  });
}
