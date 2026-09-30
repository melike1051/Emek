'use client';

import { ErrorState } from '@emek/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { toDisplayError } from '@/lib/errors';
import { onboardingRedirect } from '@/lib/session';
import { BootShell, useSession } from '@/providers/AppProviders';

/**
 * Oturum gerektiren her sayfanın kapısı. Yetki kararı **backend'dedir** (deny by default);
 * bu kapı yalnızca kullanıcıyı doğru ekrana yönlendirir, veri güvenliği sağlamaz.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { authState, session, sessionError, isSessionLoading, refreshSession } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  const redirect =
    authState === 'signedOut'
      ? `/giris?next=${encodeURIComponent(pathname)}`
      : session
        ? onboardingRedirect(session, pathname)
        : null;

  useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

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
  return <>{children}</>;
}
