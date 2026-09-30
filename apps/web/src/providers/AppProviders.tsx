'use client';

import { createApiClient, type ApiClient } from '@emek/api-client';
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Skeleton } from '@emek/ui';
import type { AuthAdapter } from '@/lib/auth/adapter';
import { getAuthAdapter } from '@/lib/auth/create-adapter';
import { createQueryClient } from '@/lib/query-client';
import { bootstrapSession, type Session } from '@/lib/session';

type AuthState = 'unknown' | 'signedOut' | 'signedIn';

interface SessionContextValue {
  auth: AuthAdapter;
  api: ApiClient;
  authState: AuthState;
  session: Session | undefined;
  sessionError: unknown;
  isSessionLoading: boolean;
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export const SESSION_QUERY_KEY = ['session'] as const;

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession AppProviders içinde kullanılmalı');
  return value;
}

export function useApi(): ApiClient {
  return useSession().api;
}

function SessionProvider({
  auth,
  api,
  children,
}: {
  auth: AuthAdapter;
  api: ApiClient;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [authState, setAuthState] = useState<AuthState>('unknown');

  useEffect(
    () =>
      auth.subscribe((signedIn) => {
        setAuthState(signedIn ? 'signedIn' : 'signedOut');
        if (!signedIn) queryClient.clear(); // başka kullanıcının verisi önbellekte kalmaz
      }),
    [auth, queryClient],
  );

  const sessionQuery = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: () => bootstrapSession(api),
    enabled: authState === 'signedIn',
    staleTime: Infinity,
  });

  const refreshSession = useCallback(
    () => queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
    [queryClient],
  );
  const signOut = useCallback(() => auth.signOut(), [auth]);

  const value = useMemo<SessionContextValue>(
    () => ({
      auth,
      api,
      authState,
      session: sessionQuery.data,
      sessionError: sessionQuery.error,
      isSessionLoading:
        authState === 'unknown' || (authState === 'signedIn' && sessionQuery.isPending),
      refreshSession,
      signOut,
    }),
    [
      auth,
      api,
      authState,
      sessionQuery.data,
      sessionQuery.error,
      sessionQuery.isPending,
      refreshSession,
      signOut,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * Firebase Auth yalnızca tarayıcıda çalışır; adapter sunucu render'ında oluşturulamaz.
 * İlk istemci render'ında kurulana kadar nötr bir yükleme kabuğu gösterilir.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthAdapter | null>(null);
  useEffect(() => {
    let live = true;
    void getAuthAdapter().then((created) => {
      if (live) setAuth(created);
    });
    return () => {
      live = false;
    };
  }, []);
  if (auth === null) return <BootShell />;
  return <ClientProviders auth={auth}>{children}</ClientProviders>;
}

export function ClientProviders({ auth, children }: { auth: AuthAdapter; children: ReactNode }) {
  const [api] = useState(() =>
    createApiClient({
      getIdToken: () => auth.getIdToken(),
      getAppCheckToken: () => auth.getAppCheckToken(),
    }),
  );
  // Sunucu 401 dönerse (token iptal/süre) oturum kapatılır; guard giriş sayfasına yönlendirir.
  const [queryClient] = useState(() => createQueryClient(() => void auth.signOut()));

  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider auth={auth} api={api}>
        {children}
      </SessionProvider>
    </QueryClientProvider>
  );
}

export function BootShell() {
  return (
    <div style={{ padding: 'var(--space-2xl) var(--page-margin)' }}>
      <Skeleton lines={3} label="Emek yükleniyor" />
    </div>
  );
}
