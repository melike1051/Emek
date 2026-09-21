import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { Request } from 'express';
import { REDIS_CLIENT } from '../cache/redis.tokens';
import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-codes';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import { RATE_LIMIT_KEY, type RateLimitOptions } from './rate-limit.decorator';

/**
 * Redis tabanlı sabit pencere oran sınırı.
 *
 * ADR-0003: rate limiting **fail-closed**'dır. Redis erişilemezse sayaç tutulamaz;
 * korumasız trafiği kabul etmek brute force ve abuse'a açık kapı bırakır. (Panic flow
 * gibi asla bloklanmaması gereken akışlar Faz 8'de bu guard'ı kullanmaz — ADR-0008 §3.)
 *
 * Sayaç **IP bazlıdır**. Bu guard, kimlik doğrulama maliyetini abuse'dan korumak için
 * `AuthGuard`'dan önce çalışır; dolayısıyla `request.user` henüz yoktur. Kullanıcı bazlı
 * kotalar (kimlik doğrulanmış yazma uçları için) auth sonrası çalışan ikinci bir guard
 * ile Faz 12'de eklenecektir.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (options === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const identity = `ip:${request.ip ?? 'unknown'}`;
    const bucket = Math.floor(Date.now() / (options.windowSeconds * 1000));
    const redisKey = `ratelimit:${options.name}:${identity}:${bucket}`;

    let count: number;
    try {
      count = await this.redis.incr(redisKey);
      if (count === 1) {
        await this.redis.expire(redisKey, options.windowSeconds);
      }
    } catch (error) {
      this.logger.error(
        { err: error, limit: options.name },
        'Oran sınırı sayacı okunamadı; istek fail-closed reddedildi',
      );
      throw new BusinessException(ErrorCode.RATE_LIMITED);
    }

    if (count > options.limit) {
      throw new BusinessException(ErrorCode.RATE_LIMITED, {
        details: { retryAfterSeconds: options.windowSeconds },
      });
    }

    return true;
  }
}
