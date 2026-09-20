import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AppRole } from '../users/user.types';

export const IS_PUBLIC_KEY = 'emek:public';
export const ROLES_KEY = 'emek:roles';

/**
 * Kimlik doğrulaması gerektirmeyen endpoint.
 *
 * Varsayılan **deny by default**'tur (ADR-0013 §2): guard tüm rotalara uygulanır ve
 * yalnızca bu dekoratörle işaretlenmiş rotalar açıktır. Bir rotayı açmak bilinçli,
 * görünür bir karar olmalı.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Endpoint'i belirli rollere kısıtlar. Rol kontrolü sahiplik kontrolünün yerini almaz. */
export const Roles = (...roles: AppRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

export interface AuthenticatedUser {
  id: string;
  roles: AppRole[];
  status: string;
  providerSubject: string;
}

/** Doğrulanmış kullanıcıyı handler parametresi olarak verir. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    if (request.user === undefined) {
      // Guard olmadan bu dekoratöre ulaşmak bir programlama hatasıdır.
      throw new Error('CurrentUser kullanıldı ama istek kimliği doğrulanmamış');
    }
    return request.user;
  },
);
