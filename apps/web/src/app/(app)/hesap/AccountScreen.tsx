'use client';

import { authApi } from '@emek/api-client';
import { Avatar, Badge, Button, Card, ErrorState, Overline, Skeleton } from '@emek/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { toDisplayError } from '@/lib/errors';
import { PROVIDER_STATE_VIEW } from '@/lib/provider-state';
import { useSession } from '@/providers/AppProviders';
import styles from '../page.module.css';

const ROLE_LABELS: Record<string, string> = {
  CUSTOMER: 'Müşteri',
  PROVIDER: 'Sağlayıcı',
  ADMIN: 'Yönetici',
  SUPPORT: 'Destek',
};

export function AccountScreen() {
  const { api, session, signOut } = useSession();
  const router = useRouter();
  const me = useQuery({ queryKey: ['users', 'me'], queryFn: () => authApi(api).me() });

  async function handleSignOut() {
    await signOut();
    router.replace('/giris');
  }

  const name = session?.customer?.displayName ?? session?.provider?.displayName ?? '';

  return (
    <AppShell title="Profilim">
      <div className={styles.stack}>
        <Card>
          <div className={styles.row}>
            <Avatar name={name} size="lg" />
            <h2>{name}</h2>
          </div>
        </Card>

        <Card>
          <Overline>Hesap</Overline>
          <div style={{ marginTop: 'var(--space-sm)' }}>
            {me.isPending ? (
              <Skeleton lines={3} label="Hesap bilgileri yükleniyor" />
            ) : me.isError ? (
              <ErrorState {...toDisplayError(me.error)} onRetry={() => void me.refetch()} />
            ) : (
              <dl className={styles.dl}>
                <dt>Telefon</dt>
                <dd>{me.data.phone ?? '—'}</dd>
                <dt>E-posta</dt>
                <dd>{me.data.email ?? '—'}</dd>
                <dt>Roller</dt>
                <dd style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
                  {me.data.roles.map((role) => (
                    <Badge key={role} tone="neutral">
                      {ROLE_LABELS[role] ?? role}
                    </Badge>
                  ))}
                </dd>
                <dt>Üyelik</dt>
                <dd>
                  {new Date(me.data.createdAt).toLocaleDateString('tr-TR', { dateStyle: 'long' })}
                </dd>
              </dl>
            )}
          </div>
        </Card>

        <Card>
          <Overline>Profiller</Overline>
          <dl className={styles.dl} style={{ marginTop: 'var(--space-sm)' }}>
            <dt>Müşteri</dt>
            <dd>{session?.customer ? 'Aktif' : 'Yok'}</dd>
            <dt>Sağlayıcı</dt>
            <dd>
              {session?.provider ? (
                <Badge tone={PROVIDER_STATE_VIEW[session.provider.state].tone}>
                  {PROVIDER_STATE_VIEW[session.provider.state].label}
                </Badge>
              ) : (
                'Yok'
              )}
            </dd>
          </dl>
          {!session?.customer || !session?.provider ? (
            <p style={{ marginTop: 'var(--space-md)' }}>
              <Link href="/rol-sec">
                {session?.provider
                  ? 'Hizmet almak için müşteri profili oluştur'
                  : 'Sağlayıcı olarak başvur'}
              </Link>
            </p>
          ) : null}
        </Card>

        <Button variant="ghost" onClick={() => void handleSignOut()}>
          Çıkış yap
        </Button>
      </div>
    </AppShell>
  );
}
