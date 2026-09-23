import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-codes';
import { AppConfigService } from '../config/app-config.service';
import type { AppEnv } from '../config/env.schema';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimitOptions } from './rate-limit.decorator';

function createContext(request: Record<string, unknown> = {}): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => ({
        socket: { remoteAddress: '10.0.0.1' },
        headers: {},
        ...request,
      }),
    }),
  } as unknown as ExecutionContext;
}

/** Varsayılan: hiçbir forwarding başlığına güvenilmez (TRUSTED_PROXY_HOP_COUNT=0). */
function createConfig(hopCount = 0): AppConfigService {
  return new AppConfigService({ TRUSTED_PROXY_HOP_COUNT: hopCount } as unknown as AppEnv);
}

function createGuard(
  options: RateLimitOptions | undefined,
  redis: { incr: jest.Mock; expire?: jest.Mock },
  hopCount = 0,
): RateLimitGuard {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(options);
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as unknown as Logger;

  return new RateLimitGuard(
    reflector,
    { expire: jest.fn(), ...redis } as unknown as Redis,
    logger,
    createConfig(hopCount),
  );
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
  // bu noktada request.user henüz yoktur. Kullanıcı bazlı kotalar UserRateLimitGuard'da.
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
  // R-53: X-Forwarded-For istemci tarafından yazılabilir. Varsayılan yapılandırmada
  // (hop sayısı 0) başlık hiç okunmaz, dolayısıyla sayaç anahtarı değiştirilemez.
  it('varsayılan yapılandırmada sahte X-Forwarded-For sayaç anahtarını değiştirmez', async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const guard = createGuard(LIMIT, { incr });

    await guard.canActivate(createContext({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }));

    expect(incr).toHaveBeenCalledWith(expect.stringContaining('ip:10.0.0.1'));
    expect(incr).not.toHaveBeenCalledWith(expect.stringContaining('1.2.3.4'));
  });

  it('güvenilen proxy ardındaki sahte önek sayaç anahtarını değiştirmez', async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const guard = createGuard(LIMIT, { incr }, 2);

    await guard.canActivate(
      createContext({ headers: { 'x-forwarded-for': 'spoof, 203.0.113.7, 35.191.0.1' } }),
    );

    expect(incr).toHaveBeenCalledWith(expect.stringContaining('ip:203.0.113.7'));
  });
});
