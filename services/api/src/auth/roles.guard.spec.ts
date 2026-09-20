import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { RolesGuard } from './roles.guard';
import type { AuthenticatedUser } from './auth.decorators';
import type { AppRole } from '../users/user.types';

function createContext(options: {
  user?: AuthenticatedUser;
  type?: 'http' | 'rpc';
}): ExecutionContext {
  return {
    getType: () => options.type ?? 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => ({ user: options.user }) }),
  } as unknown as ExecutionContext;
}

function createUser(roles: AppRole[]): AuthenticatedUser {
  return { id: 'user-1', roles, status: 'ACTIVE', providerSubject: 'sub-1' };
}

function createGuard(required?: AppRole[]): RolesGuard {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(required);
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  it('rol kısıtı olmayan rotaya izin verir', () => {
    expect(createGuard(undefined).canActivate(createContext({ user: createUser([]) }))).toBe(true);
  });

  it('gerekli role sahip kullanıcıya izin verir', () => {
    const guard = createGuard(['PROVIDER']);

    expect(guard.canActivate(createContext({ user: createUser(['CUSTOMER', 'PROVIDER']) }))).toBe(
      true,
    );
  });

  it('rolü olmayan kullanıcıyı reddeder', () => {
    const guard = createGuard(['PROVIDER']);

    try {
      guard.canActivate(createContext({ user: createUser(['CUSTOMER']) }));
      throw new Error('FORBIDDEN beklenmişti');
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessException);
      expect((error as BusinessException).code).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it('birden fazla rolden birine sahip olmak yeterlidir', () => {
    const guard = createGuard(['ADMIN', 'SUPPORT']);

    expect(guard.canActivate(createContext({ user: createUser(['SUPPORT']) }))).toBe(true);
  });

  // Rol adı benzerliği yetki vermez: 'SUPPORT' 'ADMIN' değildir.
  it('SUPPORT rolü ADMIN gerektiren rotaya erişemez', () => {
    const guard = createGuard(['ADMIN']);

    expect(() => guard.canActivate(createContext({ user: createUser(['SUPPORT']) }))).toThrow(
      BusinessException,
    );
  });

  it('kimlik doğrulanmamış istekte UNAUTHENTICATED döner', () => {
    const guard = createGuard(['CUSTOMER']);

    try {
      guard.canActivate(createContext({}));
      throw new Error('UNAUTHENTICATED beklenmişti');
    } catch (error) {
      expect((error as BusinessException).code).toBe(ErrorCode.UNAUTHENTICATED);
    }
  });

  it('HTTP dışı bağlamda devreye girmez', () => {
    const guard = createGuard(['ADMIN']);

    expect(guard.canActivate(createContext({ type: 'rpc' }))).toBe(true);
  });
});
