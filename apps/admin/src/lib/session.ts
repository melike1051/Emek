import { authApi, type ApiClient, type AppRole } from '@emek/api-client';

export interface Session {
  userId: string;
  roles: AppRole[];
}

/**
 * `POST /auth/session` — web ile aynı uç. Operasyon rolleri (ADMIN/SUPPORT) buradan atanmaz;
 * elle ve audit'li verilir (rbac-matrix). Rolü olmayan kullanıcı uygulamaya giremez.
 */
export async function bootstrapSession(client: ApiClient): Promise<Session> {
  const { userId, roles } = await authApi(client).createSession();
  return { userId, roles };
}

export function isStaff(session: Session): boolean {
  return session.roles.includes('ADMIN') || session.roles.includes('SUPPORT');
}

/**
 * Yazma eylemleri yalnız `ADMIN`'e açıktır; `SUPPORT` her ekranı okur (ADR-0013 §4).
 * Bu yalnızca **arayüz** kararıdır — yetki backend'dedir ve 403 ayrıca gösterilir.
 */
export function canWrite(session: Session): boolean {
  return session.roles.includes('ADMIN');
}
