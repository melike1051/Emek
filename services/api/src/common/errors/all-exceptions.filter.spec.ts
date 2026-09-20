import { BadRequestException, HttpStatus, InternalServerErrorException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Logger } from 'pino';
import { runWithRequestContext } from '../logging/request-context';
import { AllExceptionsFilter, type ErrorResponseBody } from './all-exceptions.filter';
import { BusinessException } from './business.exception';
import { ErrorCode } from './error-codes';

interface CapturedResponse {
  status: number;
  body: ErrorResponseBody;
}

function createHost(type: 'http' | 'rpc' = 'http'): {
  host: ArgumentsHost;
  captured: CapturedResponse;
} {
  const captured: CapturedResponse = { status: 0, body: {} as ErrorResponseBody };

  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: ErrorResponseBody) {
      captured.body = body;
      return this;
    },
  };

  const host = {
    getType: () => type,
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', url: '/api/v1/bookings' }),
    }),
  } as unknown as ArgumentsHost;

  return { host, captured };
}

function createLogger(): Logger {
  return {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

describe('AllExceptionsFilter', () => {
  it('BusinessException kodunu ve koda bağlı varsayılan mesajı döner', () => {
    const { host, captured } = createHost();

    new AllExceptionsFilter(createLogger()).catch(
      new BusinessException(ErrorCode.NOT_FOUND, { details: { resource: 'booking' } }),
      host,
    );

    expect(captured.status).toBe(HttpStatus.NOT_FOUND);
    expect(captured.body.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(captured.body.error.message).toBe('Kaynak bulunamadı.');
    expect(captured.body.error.details).toEqual({ resource: 'booking' });
  });

  it('açıkça verilen istemci mesajını kullanır', () => {
    const { host, captured } = createHost();

    new AllExceptionsFilter(createLogger()).catch(
      new BusinessException(ErrorCode.FORBIDDEN, {
        clientMessage: 'Bu rezervasyonu görüntüleme yetkiniz yok.',
      }),
      host,
    );

    expect(captured.body.error.message).toBe('Bu rezervasyonu görüntüleme yetkiniz yok.');
  });

  it('beklenmeyen hatada iç detay sızdırmaz', () => {
    const { host, captured } = createHost();

    new AllExceptionsFilter(createLogger()).catch(
      new Error('relation "users" does not exist at character 15 — postgres://user:pw@host'),
      host,
    );

    expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured.body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(captured.body.error.message).toBe('Beklenmeyen bir hata oluştu.');
    expect(JSON.stringify(captured.body)).not.toContain('users');
    expect(JSON.stringify(captured.body)).not.toContain('postgres://');
  });

  it('5xx HttpException mesajını da sızdırmaz', () => {
    const { host, captured } = createHost();

    new AllExceptionsFilter(createLogger()).catch(
      new InternalServerErrorException('payment provider secret rotated'),
      host,
    );

    expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured.body.error.message).toBe('Beklenmeyen bir hata oluştu.');
    expect(JSON.stringify(captured.body)).not.toContain('secret');
  });

  it('ValidationPipe alan hatalarını yapısal biçimde taşır', () => {
    const { host, captured } = createHost();

    new AllExceptionsFilter(createLogger()).catch(
      new BadRequestException(['scheduledStart must be a valid ISO 8601 date']),
      host,
    );

    expect(captured.status).toBe(HttpStatus.BAD_REQUEST);
    expect(captured.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(captured.body.error.message).toBe('İstek doğrulanamadı.');
    expect(captured.body.error.details).toEqual({
      fields: ['scheduledStart must be a valid ISO 8601 date'],
    });
  });

  it('yanıta istek bağlamındaki requestId eklenir', () => {
    const { host, captured } = createHost();
    const filter = new AllExceptionsFilter(createLogger());

    runWithRequestContext({ requestId: 'req-123' }, () => {
      filter.catch(new Error('boom'), host);
    });

    expect(captured.body.error.requestId).toBe('req-123');
  });

  it('5xx sunucu tarafında error seviyesinde loglanır', () => {
    const { host } = createHost();
    const logger = createLogger();

    new AllExceptionsFilter(logger).catch(new Error('boom'), host);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('4xx sunucu tarafında warn seviyesinde loglanır', () => {
    const { host } = createHost();
    const logger = createLogger();

    new AllExceptionsFilter(logger).catch(new BusinessException(ErrorCode.FORBIDDEN), host);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  // Faz 9'da Pub/Sub consumer'ları HTTP dışı bağlamda çalışacak: filter orada
  // Express response aramaya kalkarsa hata yönetiminin kendisi patlar.
  it('HTTP dışı bağlamda yanıt üretmeye çalışmaz, yalnızca loglar', () => {
    const { host, captured } = createHost('rpc');
    const logger = createLogger();

    expect(() => new AllExceptionsFilter(logger).catch(new Error('boom'), host)).not.toThrow();

    expect(captured.status).toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
