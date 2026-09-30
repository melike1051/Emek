'use client';

import { Button, EmptyState, ErrorState } from '@emek/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { toDisplayError } from '@/lib/errors';
import { isStaff } from '@/lib/session';
import { BootShell, useSession } from '@/providers/AppProviders';

/**
 * Operasyon ekranlarının kapısı: yalnızca ADMIN/SUPPORT içeri girer. Bu bir yönlendirmedir,
 * güvenlik sınırı değildir — her uç backend'de ayrıca rol kontrolünden geçer (deny by default).
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { authState, session, sessionError, isSessionLoading, refreshSession, signOut } =
    useSession();
  const router = useRouter();
  const pathname = usePathname();

  const redirect = authState === 'signedOut';
  useEffect(() => {
    if (!redirect) return;
    // Sorgu dizesi korunur (ör. `/odemeler?bookingId=…` filtresi); `useSearchParams` Suspense
    // sınırı istediğinden adres doğrudan okunur. Doğrulama girişte `safeNextPath` ile yapılır.
    const next = `${pathname}${window.location.search}`;
    router.replace(`/giris?next=${encodeURIComponent(next)}`);
  }, [redirect, pathname, router]);

  if (sessionError && !session) {
    const { message, requestId } = toDisplayError(sessionError);
    return (
      <main style={{ padding: 'var(--space-2xl) var(--page-margin)' }}>
        <ErrorState
          title="Oturum açılamadı"
          message={message}
          requestId={requestId}
          onRetry={() => void refreshSession()}
        />
      </main>
    );
  }
  if (isSessionLoading || redirect || !session) return <BootShell />;
  if (!isStaff(session)) {
    return (
      <main
        style={{
          padding: 'var(--space-2xl) var(--page-margin)',
          maxWidth: '40rem',
          margin: '0 auto',
        }}
      >
        <EmptyState
          title="Bu alan operasyon ekibine özeldir"
          description="Hesabınızda ADMIN veya SUPPORT rolü yok. Rol ataması yalnızca yetkili bir yönetici tarafından, kayıt altında yapılır."
          action={
            <Button variant="secondary" onClick={() => void signOut()}>
              Çıkış yap
            </Button>
          }
        />
      </main>
    );
  }
  return <>{children}</>;
}
