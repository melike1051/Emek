import { pino, type Logger } from 'pino';
import { createRootLogger, requestContextMixin } from './logger';
import { maskSensitive } from './redact';
import { runWithRequestContext, setRequestUser } from './request-context';

/** Gerçek formatter/mixin yapılandırmasını, satırları yakalayan bir stream ile test eder. */
function captureLogs(): { lines: Record<string, unknown>[]; logger: Logger } {
  const lines: Record<string, unknown>[] = [];

  const logger = pino(
    {
      level: 'info',
      formatters: { log: (object) => maskSensitive(object) as Record<string, unknown> },
      mixin: requestContextMixin,
    },
    { write: (chunk: string) => lines.push(JSON.parse(chunk) as Record<string, unknown>) },
  );

  return { lines, logger };
}

describe('log redaction', () => {
  it('üst seviye hassas alanları maskeler', () => {
    const { lines, logger } = captureLogs();

    logger.info({ token: 'eyJhbGciOi.secret', otp: '123456', tckn: '12345678901' }, 'flat');

    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain('eyJhbGciOi.secret');
    expect(line).not.toContain('123456');
    expect(line).not.toContain('12345678901');
    expect(line).toContain('[REDACTED]');
  });

  // pino'nun redact.paths seçeneği joker başına tek seviye eşler; derin nesneler
  // maskelenmeden loglanırdı. Bu test o regresyonu kapatır.
  it('derin iç içe nesnelerde de maskeler', () => {
    const { lines, logger } = captureLogs();

    logger.info(
      {
        payload: {
          customer: { profile: { nationalId: '12345678901', identityHash: 'a'.repeat(64) } },
          items: [{ card: { cardNumber: '4111111111111111', cvv: '123' } }],
        },
      },
      'nested',
    );

    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain('12345678901');
    expect(line).not.toContain('a'.repeat(64));
    expect(line).not.toContain('4111111111111111');
    expect(line).toContain('[REDACTED]');
  });

  it('hata nesnesi loglanırken hassas alanlar maskelenir', () => {
    const { lines, logger } = captureLogs();
    const error = Object.assign(new Error('insert failed'), { token: 'leaked-token' });

    logger.error({ err: error, context: { password: 'hunter2' } }, 'failure');

    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain('leaked-token');
    expect(line).not.toContain('hunter2');
  });

  it('hassas olmayan alanları korur', () => {
    const { lines, logger } = captureLogs();

    logger.info({ bookingId: 'b-1', nested: { status: 'CONFIRMED' } }, 'state change');

    expect(lines[0]).toMatchObject({ bookingId: 'b-1', nested: { status: 'CONFIRMED' } });
  });

  it('maskeleme çağıranın nesnesini değiştirmez', () => {
    const payload = { token: 'original-token' };

    maskSensitive(payload);

    expect(payload.token).toBe('original-token');
  });
});

describe('requestContextMixin', () => {
  it('istek bağlamı dışında boş döner', () => {
    expect(requestContextMixin()).toEqual({});
  });

  it('requestId her log satırına eklenir', () => {
    const { lines, logger } = captureLogs();

    runWithRequestContext({ requestId: 'req-42' }, () => {
      logger.info('inside request');
    });

    expect(lines[0]).toMatchObject({ requestId: 'req-42' });
  });

  it('istemci izleme kimliği varsa taşınır', () => {
    const { lines, logger } = captureLogs();

    runWithRequestContext({ requestId: 'req-43', clientTraceId: 'trace-1' }, () => {
      logger.info('with trace');
    });

    expect(lines[0]).toMatchObject({ requestId: 'req-43', clientTraceId: 'trace-1' });
  });

  it('bağlam dışında setRequestUser çağrısı akışı düşürmez', () => {
    expect(() => setRequestUser('user-9')).not.toThrow();
  });
});

describe('createRootLogger', () => {
  it('istenen seviyede logger üretir', () => {
    expect(createRootLogger({ level: 'warn', pretty: false }).level).toBe('warn');
  });
});
