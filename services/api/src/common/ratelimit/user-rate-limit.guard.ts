import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../auth/auth.decorators';
import { REDIS_CLIENT } from '../cache/redis.tokens';
import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-codes';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import { USER_RATE_LIMIT_KEY, type UserRateLimitOptions } from './user-rate-limit.decorator';

/**
 * Kullanıcı başına sabit pencere oran sınırı. `AuthGuard`'dan **sonra** çalışır.
 *
 * Fail-closed'dır (ADR-0003): Redis okunamıyorsa istek reddedilir. Kimliği
 * doğrulanmamış istekte sayaç tutulmaz — o trafiği IP bazlı guard karşılar;
 * burada ikinci kez saymak `@Public()` uçları iki kere cezalandırırdı.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const options = this.reflector.getAllAndOverride<UserRateLimitOptions | undefined>(
      USER_RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (options === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;

    if (user === undefined) {
      return true;
    }

    const bucket = Math.floor(Date.now() / (options.windowSeconds * 1000));
    const redisKey = `ratelimit:user:${options.name}:${user.id}:${bucket}`;

    let count: number;
    try {
      count = await this.redis.incr(redisKey);
      if (count === 1) {
        await this.redis.expire(redisKey, options.windowSeconds);
      }
    } catch (error) {
      this.logger.error(
        { err: error, limit: options.name },
        'Kullanıcı oran sınırı sayacı okunamadı; istek fail-closed reddedildi',
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
