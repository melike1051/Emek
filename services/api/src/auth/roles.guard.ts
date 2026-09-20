import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import type { AppRole } from '../users/user.types';
import { ROLES_KEY, type AuthenticatedUser } from './auth.decorators';

/**
 * Rol kontrolü. `@Roles()` yoksa rota rol kısıtı olmadan (ama yine kimlik doğrulamalı)
 * çalışır. Rol yetki için **yeterli değildir**: kaynak sahipliği ayrıca kontrol edilir
 * (ADR-0013 §1).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const required = this.reflector.getAllAndOverride<AppRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required === undefined || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;

    if (user === undefined) {
      throw new BusinessException(ErrorCode.UNAUTHENTICATED);
    }

    if (!required.some((role) => user.roles.includes(role))) {
      throw new BusinessException(ErrorCode.FORBIDDEN);
    }

    return true;
  }
}
