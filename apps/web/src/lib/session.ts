import {
  authApi,
  profilesApi,
  type ApiClient,
  type AppRole,
  type CustomerProfile,
  type ProviderProfile,
} from '@emek/api-client';

export interface Session {
  userId: string;
  roles: AppRole[];
  customer: CustomerProfile | null;
  provider: ProviderProfile | null;
}

/**
 * Oturumu kurar: `POST /auth/session` ilk girişte Emek kullanıcısını oluşturur (idempotent),
 * ardından profiller paralel okunur. Profil yoksa `null` (PROFILE_NOT_FOUND bir durumdur).
 */
export async function bootstrapSession(client: ApiClient): Promise<Session> {
  const auth = await authApi(client).createSession();
  const profiles = profilesApi(client);
  // `/providers/me` PROVIDER rolü ister; rolü olmayana 403 döner (profil yokluğu değil).
  const [customer, provider] = await Promise.all([
    profiles.customer(),
    auth.roles.includes('PROVIDER') ? profiles.provider() : Promise.resolve(null),
  ]);
  return { userId: auth.userId, roles: auth.roles, customer, provider };
}

export type Workspace = 'customer' | 'provider';

/** Oturum kurulduktan sonra kullanıcının gitmesi gereken yer; `null` → istenen sayfada kal. */
export function onboardingRedirect(session: Session, pathname: string): string | null {
  if (session.customer === null && session.provider === null) {
    return pathname === '/rol-sec' ? null : '/rol-sec';
  }
  // `/rol-sec` ikinci profil eklemek için de kullanılır; iki profil de varsa oradan çıkışı
  // RoleSelect yönetir (profil oluşturma sonrası kendi hedefine gitmesiyle yarışmasın diye).
  if (pathname.startsWith('/panel') && session.provider === null) return '/';
  return null;
}

/** Varsayılan çalışma alanı: yalnızca sağlayıcı profili varsa panel, aksi hâlde müşteri. */
export function defaultHome(session: Session): string {
  return session.customer === null && session.provider !== null ? '/panel' : '/';
}
