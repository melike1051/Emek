'use client';

import { bookingsApi, catalogApi, type Booking } from '@emek/api-client';
import { Badge, Card, EmptyState, ErrorState, Skeleton } from '@emek/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { formatMoney, formatRange, isActiveBooking } from '@/lib/booking';
import { toDisplayError } from '@/lib/errors';
import { providerBookingStatusView } from '@/lib/provider';
import { useSession } from '@/providers/AppProviders';
import flow from '../../flow.module.css';

type Tab = 'active' | 'past';

export function ProviderBookingsList() {
  return (
    <AppShell title="Randevular">
      <List />
    </AppShell>
  );
}

function List() {
  const { api, session } = useSession();
  const [tab, setTab] = useState<Tab>('active');
  const bookings = useQuery({ queryKey: ['bookings'], queryFn: () => bookingsApi(api).list() });
  const services = useQuery({
    queryKey: ['catalog', 'services'],
    queryFn: () => catalogApi(api).services(),
  });

  if (bookings.isPending) return <Skeleton lines={4} label="Randevular yükleniyor" />;
  if (bookings.isError) {
    return (
      <ErrorState {...toDisplayError(bookings.error)} onRetry={() => void bookings.refetch()} />
    );
  }

  // Aynı hesap müşteri de olabilir: bu ekran yalnızca sağlayıcı olarak verilen hizmetleri gösterir.
  const mine = bookings.data.filter((b) => b.providerId === session?.userId);
  const shown = mine
    .filter((b) => isActiveBooking(b.status) === (tab === 'active'))
    .sort((a, b) =>
      tab === 'active'
        ? a.scheduledStart.localeCompare(b.scheduledStart)
        : b.scheduledStart.localeCompare(a.scheduledStart),
    );
  const serviceName = (b: Booking) =>
    services.data?.find((s) => s.id === b.serviceId)?.name ?? 'Hizmet';

  return (
    <div className={flow.stack}>
      <div role="tablist" aria-label="Randevu listesi" className={flow.tabs}>
        {(['active', 'past'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            className={flow.tab}
            aria-selected={tab === value}
            onClick={() => setTab(value)}
          >
            {value === 'active' ? 'Aktif' : 'Geçmiş'}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState
          title={tab === 'active' ? 'Aktif randevunuz yok' : 'Geçmiş randevunuz yok'}
          {...(tab === 'active'
            ? {
                description:
                  'Onaylı profil, hizmet, bölge ve müsaitlikle uygun talepler size gelir.',
                action: <Link href="/panel/musaitlik">Müsaitliğimi düzenle</Link>,
              }
            : {})}
        />
      ) : (
        <ul className={flow.list} role="tabpanel">
          {shown.map((booking) => {
            const view = providerBookingStatusView(booking.status);
            return (
              <li key={booking.id}>
                <Link href={`/panel/randevular/${booking.id}`} className={flow.cardLink}>
                  <Card as="article">
                    <div className={flow.between}>
                      <div>
                        <h3>{serviceName(booking)}</h3>
                        <p className={flow.small}>
                          {formatRange(booking.scheduledStart, booking.scheduledEnd)}
                        </p>
                      </div>
                      <Badge tone={view.tone}>{view.label}</Badge>
                    </div>
                    <p className={flow.muted} style={{ marginTop: 'var(--space-xs)' }}>
                      {formatMoney(booking.priceMinor, booking.currency)}
                    </p>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
