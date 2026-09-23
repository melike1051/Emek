import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-codes';
import { UserRateLimitGuard } from './user-rate-limit.guard';
import type { UserRateLimitOptions } from './user-rate-limit.decorator';

function createContext(user?: { id: string }): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => ({ ip: '10.0.0.1', user }) }),
  } as unknown as ExecutionContext;
}

function createGuard(
  options: UserRateLimitOptions | undefined,
  redis: { incr: jest.Mock; expire?: jest.Mock },
): UserRateLimitGuard {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(options);
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as unknown as Logger;
  return new UserRateLimitGuard(
    reflector,
    { expire: jest.fn(), ...redis } as unknown as Redis,
    logger,
  );
}

const LIMIT: UserRateLimitOptions = { name: 'test', limit: 3, windowSeconds: 60 };

describe('UserRateLimitGuard', () => {
  it('sınır tanımlı olmayan rotayı serbest bırakır', async () => {
    const guard = createGuard(undefined, { incr: jest.fn() });
    await expect(guard.canActivate(createContext({ id: 'u1' }))).resolves.toBe(true);
  });

  it('sayaç kullanıcı kimliğine bağlıdır, IP tabanlı değil', async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const guard = createGuard(LIMIT, { incr });

    await guard.canActivate(createContext({ id: 'user-7' }));

    expect(incr).toHaveBeenCalledWith(expect.stringContaining('ratelimit:user:test:user-7:'));
    expect(incr).not.toHaveBeenCalledWith(expect.stringContaining('10.0.0.1'));
  });

  it('sınırı aşan kullanıcıyı reddeder', async () => {
    const guard = createGuard(LIMIT, { incr: jest.fn().mockResolvedValue(4) });

    await expect(guard.canActivate(createContext({ id: 'u1' }))).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMITED,
    });
  });

  it('iki farklı kullanıcı birbirinin kotasını tüketmez', async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const guard = createGuard(LIMIT, { incr });

    await guard.canActivate(createContext({ id: 'user-a' }));
    await guard.canActivate(createContext({ id: 'user-b' }));

    const keys = incr.mock.calls.map((call) => call[0] as string);
    expect(new Set(keys).size).toBe(2);
  });

  it('kimliksiz istekte sayaç tutulmaz (IP guard zaten saymıştır)', async () => {
    const incr = jest.fn();
    const guard = createGuard(LIMIT, { incr });

    await expect(guard.canActivate(createContext(undefined))).resolves.toBe(true);
    expect(incr).not.toHaveBeenCalled();
  });

  it('Redis erişilemezken isteği reddeder (fail-closed)', async () => {
    const guard = createGuard(LIMIT, {
      incr: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    await expect(guard.canActivate(createContext({ id: 'u1' }))).rejects.toThrow(BusinessException);
  });

  it('ilk istekte pencere süresi ayarlanır', async () => {
    const expire = jest.fn();
    const guard = createGuard(LIMIT, { incr: jest.fn().mockResolvedValue(1), expire });

    await guard.canActivate(createContext({ id: 'u1' }));

    expect(expire).toHaveBeenCalledWith(expect.stringContaining('ratelimit:user:test:'), 60);
  });
});
