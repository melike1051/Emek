import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { setRequestUser } from '../common/logging/request-context';
import { UsersService } from '../users/users.service';
import { IS_PUBLIC_KEY, type AuthenticatedUser } from './auth.decorators';
import { InvalidTokenError, TOKEN_VERIFIER, type TokenVerifier } from './token-verifier';

const BEARER_PREFIX = 'Bearer ';

/**
 * Global kimlik doğrulama guard'ı — **deny by default**.
 *
 * `@Public()` ile işaretlenmemiş her rota geçerli bir token ister. Token doğrulandıktan
 * sonra kullanıcı ve rolleri **veritabanından** okunur: yetki kaynağı token claim'leri
 * değil, Emek'in kendi RBAC tablosudur (ADR-0013).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly tokenVerifier: TokenVerifier,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const header = request.header('authorization');

    if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
      throw new BusinessException(ErrorCode.UNAUTHENTICATED);
    }

    const verified = await this.verify(header.slice(BEARER_PREFIX.length).trim());
    const user = await this.users.findByProviderSubject(verified.subject);

    if (user === null) {
      // Token geçerli ama Emek'te kullanıcı yok: kayıt akışı (POST /auth/session) çağrılmalı.
      throw new BusinessException(ErrorCode.UNAUTHENTICATED);
    }

    if (user.status === 'SUSPENDED' || user.status === 'DELETED') {
      throw new BusinessException(ErrorCode.FORBIDDEN, {
        clientMessage: 'Hesabınız şu anda kullanılamıyor.',
      });
    }

    request.user = {
      id: user.id,
      roles: user.roles,
      status: user.status,
      providerSubject: verified.subject,
    };
    // Loglara kullanıcı bağlamı eklenir (PII değil, yalnızca id).
    setRequestUser(user.id);

    return true;
  }

  private async verify(rawToken: string): Promise<{ subject: string }> {
    if (rawToken.length === 0) {
      throw new BusinessException(ErrorCode.UNAUTHENTICATED);
    }

    try {
      return await this.tokenVerifier.verify(rawToken);
    } catch (error) {
      // Doğrulama hatasının nedeni istemciye sızdırılmaz.
      if (error instanceof InvalidTokenError) {
        throw new BusinessException(ErrorCode.UNAUTHENTICATED);
      }
      throw error;
    }
  }
}
