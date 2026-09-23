import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Logger } from 'pino';
import { AppConfigService } from '../config/app-config.service';
import { BusinessException } from '../errors/business.exception';
import { ErrorCode } from '../errors/error-codes';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import {
  APP_CHECK_VERIFIER,
  InvalidAppCheckTokenError,
  type AppCheckVerifier,
} from './app-check-verifier';
import { SKIP_APP_CHECK_KEY } from './app-check.decorators';

export const APP_CHECK_HEADER = 'x-firebase-appcheck';

/**
 * Firebase App Check zorunluluğu — **deny by default** (istisnalar açıkça işaretlenir).
 *
 * Guard sırası: oran sınırı → **App Check** → kimlik → rol. App Check kimlik
 * doğrulamadan önce gelir; amaç, çalınmış bir token'la yazılmış bir script'in
 * veya emülatörün pahalı uçlara hiç ulaşamamasıdır.
 *
 * `APP_CHECK_ENABLED=false` iken guard tamamen devre dışıdır. Bu, Faz 16'ya
 * (Flutter istemcisi) kadar geliştirme ve testin çalışmasını sağlar; production
 * config'inde zorunlu açıktır (env.schema superRefine).
 *
 * App Check yetkilendirme **değildir**: geçen bir istek hâlâ AuthGuard ve RBAC
 * kapılarından geçmek zorundadır.
 */
@Injectable()
export class AppCheckGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfigService,
    @Inject(APP_CHECK_VERIFIER) private readonly verifier: AppCheckVerifier,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http' || !this.config.env.APP_CHECK_ENABLED) {
      return true;
    }

    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_APP_CHECK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skip === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.header(APP_CHECK_HEADER);

    if (header === undefined || header.trim().length === 0) {
      throw new BusinessException(ErrorCode.APP_CHECK_REQUIRED);
    }

    try {
      await this.verifier.verify(header.trim());
    } catch (error) {
      if (error instanceof InvalidAppCheckTokenError) {
        // Reddin nedeni istemciye sızdırılmaz; tarafımızda teşhis için loglanır.
        this.logger.warn({ reason: error.message }, 'App Check token reddedildi');
        throw new BusinessException(ErrorCode.APP_CHECK_REQUIRED);
      }
      throw error;
    }

    return true;
  }
}
