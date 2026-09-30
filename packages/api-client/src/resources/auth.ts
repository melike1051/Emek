import type { ApiClient } from '../client';

/** Kaynak: services/api/src/users/user.types.ts */
export type AppRole = 'CUSTOMER' | 'PROVIDER' | 'ADMIN' | 'SUPPORT';
export type UserStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELETED';

/** Kaynak: services/api/src/auth/dto/session.dto.ts (R-99: yanıt şeması OpenAPI'de yok). */
export interface AuthSession {
  userId: string;
  roles: AppRole[];
  status: UserStatus;
  registered: boolean;
}

/** Kaynak: services/api/src/users/dto/user.dto.ts (UserResponseDto) */
export interface CurrentUser {
  id: string;
  email: string | null;
  phone: string | null;
  status: UserStatus;
  roles: AppRole[];
  createdAt: string;
  lastLoginAt: string | null;
}

export function authApi(client: ApiClient) {
  return {
    /** İlk girişte Emek kullanıcısını oluşturur; sonraki girişlerde mevcut kaydı döner. */
    createSession: () => client.post<AuthSession>('/auth/session'),
    me: () => client.get<CurrentUser>('/users/me'),
  };
}
