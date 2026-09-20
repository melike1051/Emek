import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-codes';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimitOptions } from './rate-limit.decorator';

function createContext(request: Record<string, unknown> = {}): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => ({ ip: '10.0.0.1', ...request }) }),
  } as unknown as ExecutionContext;
}

function createGuard(
  options: RateLimitOptions | undefined,
  redis: { incr: jest.Mock; expire?: jest.Mock },
): RateLimitGuard {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(options);
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as unknown as Logger;

  return new RateLimitGuard(reflector, { expire: jest.fn(), ...redis } as unknown as Redis, logger);
}

const LIMIT: RateLimitOptions = { name: 'test', limit: 3, windowSeconds: 60 };

describe('RateLimitGuard', () => {
  it('oran sınırı tanımlı olmayan rotayı serbest bırakır', async () => {
    const guard = createGuard(undefined, { incr: jest.fn() });

    await expect(guard.canActivate(createContext())).resolves.toBe(true);
  });

  it('sınır altındaki isteğe izin verir', async () => {
    const guard = createGuard(LIMIT, { incr: jest.fn().mockResolvedValue(3) });

    await expect(guard.canActivate(createContext())).resolves.toBe(true);
  });

  it('sınırı aşan isteği reddeder', async () => {
    const guard = createGuard(LIMIT, { incr: jest.fn().mockResolvedValue(4) });

    try {
      await guard.canActivate(createContext());
      throw new Error('RATE_LIMITED beklenmişti');
    } catch (error) {
      expect((error as BusinessException).code).toBe(ErrorCode.RATE_LIMITED);
    }
  });

  it('ilk istekte pencere süresi ayarlanır', async () => {
    const expire = jest.fn();
    const guard = createGuard(LIMIT, { incr: jest.fn().mockResolvedValue(1), expire });

    await guard.canActivate(createContext());

    expect(expire).toHaveBeenCalledWith(expect.stringContaining('ratelimit:test:'), 60);
  });

  // ADR-0003: oran sınırı fail-closed'dır. Redis yokken korumasız trafik kabul edilmez.
  it('Redis erişilemezken isteği reddeder (fail-closed)', async () => {
    const guard = createGuard(LIMIT, {
      incr: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    await expect(guard.canActivate(createContext())).rejects.toThrow(BusinessException);
  });

  // Guard, kimlik doğrulama maliyetini korumak için AuthGuard'dan ÖNCE çalışır;
  // bu noktada request.user henüz yoktur. Kullanıcı bazlı kotalar Faz 12'de auth
  // sonrası çalışan ikinci bir guard ile gelir.
  it('kullanıcı bilgisi olsa bile sayaç IP bazlıdır', async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const guard = createGuard(LIMIT, { incr });

    await guard.canActivate(createContext({ user: { id: 'user-7' } }));

    expect(incr).toHaveBeenCalledWith(expect.stringContaining('ip:10.0.0.1'));
    expect(incr).not.toHaveBeenCalledWith(expect.stringContaining('user:'));
  });

  it('anonim istekte sayaç IP bazlıdır', async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const guard = createGuard(LIMIT, { incr });

    await guard.canActivate(createContext());

    expect(incr).toHaveBeenCalledWith(expect.stringContaining('ip:10.0.0.1'));
  });
});
