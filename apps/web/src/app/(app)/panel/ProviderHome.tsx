'use client';

import { bookingsApi, identityApi, providersApi, type Booking } from '@emek/api-client';
import { Avatar, Badge, Button, Card, ErrorState, Overline, Skeleton } from '@emek/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { formatRange } from '@/lib/booking';
import { toDisplayError } from '@/lib/errors';
import { providerBookingStatusView, readiness } from '@/lib/provider';
import { PROVIDER_STATE_VIEW } from '@/lib/provider-state';
import { useProviderQueries } from '@/lib/provider-queries';
import { useSession } from '@/providers/AppProviders';
import flow from '../flow.module.css';
import styles from '../page.module.css';

/** Sağlayıcı ana ekranı: başvuru durumu, hazırlık listesi ve yanıt bekleyen işler. */
export function ProviderHome() {
  const { session } = useSession();
  const provider = session?.provider;
  if (!provider) return null; // SessionGate sağlayıcı profili olmayanı buraya almaz

  const state = PROVIDER_STATE_VIEW[provider.state];
  return (
    <AppShell title="Atölyem">
      <div className={styles.stack}>
        <Card>
          <div className={styles.row}>
            <Avatar
              name={provider.displayName}
              size="lg"
              verified={provider.state === 'APPROVED'}
            />
            <div className={styles.stack} style={{ gap: 'var(--space-2xs)' }}>
              <h2>{provider.displayName}</h2>
              <span>
                <Badge tone={state.tone}>{state.label}</Badge>
              </span>
            </div>
          </div>
          <p style={{ marginTop: 'var(--space-sm)' }}>{state.next}</p>
        </Card>
        <Readiness />
        <PendingWork userId={provider.userId} />
      </div>
    </AppShell>
  );
}

function Readiness() {
  const { api, session, refreshSession } = useSession();
  const provider = session!.provider!;
  const { services, areas, upcoming } = useProviderQueries();
  const identity = useQuery({
    queryKey: ['identity', 'status'],
    queryFn: () => identityApi(api).status(),
  });
  const submit = useMutation({
    mutationFn: () => providersApi(api).submit(),
    onSuccess: () => refreshSession(),
  });

  if (services.isPending || areas.isPending || upcoming.isPending) {
    return <Skeleton lines={4} label="Hazırlık durumu yükleniyor" />;
  }
  const failed = [services, areas, upcoming].find((query) => query.isError);
  if (failed) {
    return <ErrorState {...toDisplayError(failed.error)} onRetry={() => void failed.refetch()} />;
  }

  const items = readiness({
    bio: provider.bio,
    services: services.data!,
    areas: areas.data!,
    upcomingAvailability: upcoming.data!.length,
    identityVerified: identity.data?.identityVerified ?? false,
  });
  // Kimlik doğrulaması başvuruyu değil eşleştirmeyi bloklar; başvuru onu beklemez.
  const ready = items.filter((item) => item.key !== 'identity').every((item) => item.done);
  const canSubmit = provider.state === 'DRAFT' || provider.state === 'REJECTED';

  return (
    <Card>
      <Overline>Hazırlık</Overline>
      <ul className={flow.list} style={{ marginTop: 'var(--space-sm)' }} aria-label="Hazırlık">
        {items.map((item) => (
          <li key={item.key} className={flow.between}>
            {item.href && !item.done ? <Link href={item.href}>{item.label}</Link> : item.label}
            <Badge tone={item.done ? 'trust' : 'neutral'}>{item.done ? 'Tamam' : 'Eksik'}</Badge>
          </li>
        ))}
      </ul>
      {identity.data && !identity.data.identityVerified ? (
        <p className={flow.notice} style={{ marginTop: 'var(--space-sm)' }}>
          Kimliği doğrulanmamış sağlayıcılar eşleştirmeye dahil edilmez. Doğrulama adımı yakında
          buradan başlatılabilecek.
        </p>
      ) : null}
      {canSubmit ? (
        <div className={flow.stack} style={{ marginTop: 'var(--space-md)' }}>
          {submit.error ? <ErrorState {...toDisplayError(submit.error)} /> : null}
          {!ready ? (
            <p className={flow.small}>Başvuruyu göndermek için eksik adımları tamamlayın.</p>
          ) : null}
          <Button disabled={!ready} loading={submit.isPending} onClick={() => submit.mutate()}>
            {provider.state === 'REJECTED' ? 'Yeniden başvur' : 'Başvuruyu incelemeye gönder'}
          </Button>
        </div>
      ) : null}
      <div className={flow.row} style={{ marginTop: 'var(--space-md)' }}>
        <Link href="/panel/profil">Profil</Link>
        <Link href="/panel/hizmetler">Hizmetler</Link>
        <Link href="/panel/bolgeler">Bölgeler</Link>
        <Link href="/panel/musaitlik">Müsaitlik</Link>
      </div>
    </Card>
  );
}

const NEEDS_ATTENTION: ReadonlySet<string> = new Set([
  'PROVIDER_PENDING',
  'SCHEDULED',
  'PROVIDER_ARRIVING',
  'CHECKED_IN',
  'IN_PROGRESS',
]);

function PendingWork({ userId }: { userId: string }) {
  const { api } = useSession();
  const bookings = useQuery({ queryKey: ['bookings'], queryFn: () => bookingsApi(api).list() });
  if (bookings.isPending) return <Skeleton lines={2} label="Randevular yükleniyor" />;
  if (bookings.isError) {
    return (
      <ErrorState {...toDisplayError(bookings.error)} onRetry={() => void bookings.refetch()} />
    );
  }
  const work: Booking[] = bookings.data
    .filter((b) => b.providerId === userId && NEEDS_ATTENTION.has(b.status))
    .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))
    .slice(0, 5);
  if (work.length === 0) return null;
  return (
    <Card>
      <Overline>Sıradaki işler</Overline>
      <ul className={flow.list} style={{ marginTop: 'var(--space-sm)' }}>
        {work.map((booking) => {
          const view = providerBookingStatusView(booking.status);
          return (
            <li key={booking.id} className={flow.between}>
              <Link href={`/panel/randevular/${booking.id}`}>
                {formatRange(booking.scheduledStart, booking.scheduledEnd)}
              </Link>
              <Badge tone={view.tone}>{view.label}</Badge>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
