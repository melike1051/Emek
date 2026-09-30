'use client';

import type { BookingStatus } from '@emek/api-client';
import { Card } from '@emek/ui';
import Link from 'next/link';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { CursorList, useCursorList } from '@/components/CursorList';
import { Facts, FilterBar, Id, SelectFilter } from '@/components/Filters';
import { IdFilter } from '@/components/IdFilter';
import { StatusBadge } from '@/components/StatusBadge';
import styles from '@/components/admin.module.css';
import { formatDateTime, formatMoney, uuidOrUndefined } from '@/lib/format';
import { BOOKING_STATUSES, bookingStatusView } from '@/lib/labels';
import { useAdminApi } from '@/providers/AppProviders';

/**
 * İzleme listesi (salt okunur). Randevu üzerinde operatör geçişi yoktur; tek rezervasyon ve
 * durum geçmişi uçları yalnız taraflara açık olduğundan ayrıntı sayfası yoktur (R-104).
 */
export function BookingsScreen() {
  const api = useAdminApi();
  const [status, setStatus] = useState('');
  const [customer, setCustomer] = useState('');
  const [provider, setProvider] = useState('');
  const filters = {
    status: (status || undefined) as BookingStatus | undefined,
    customerId: uuidOrUndefined(customer),
    providerId: uuidOrUndefined(provider),
  };
  const query = useCursorList(['bookings', filters], (cursor) =>
    api.bookings.list({ ...filters, cursor }),
  );

  return (
    <AppShell title="Randevular">
      <div className={styles.stack}>
        <FilterBar>
          <SelectFilter
            label="Durum"
            value={status}
            allLabel="Tümü"
            options={BOOKING_STATUSES.map((value) => ({
              value,
              label: `${bookingStatusView(value).label} (${value})`,
            }))}
            onChange={setStatus}
          />
          <IdFilter label="Müşteri kimliği" value={customer} onChange={setCustomer} />
          <IdFilter label="Sağlayıcı kimliği" value={provider} onChange={setProvider} />
        </FilterBar>
        <CursorList
          query={query}
          itemKey={(booking) => booking.id}
          emptyTitle="Randevu bulunamadı"
          emptyDescription="Filtreleri değiştirip tekrar deneyin."
          renderItem={(booking) => (
            <Card>
              <div className={styles.between}>
                <p>
                  Randevu <Id value={booking.id} />
                </p>
                <StatusBadge view={bookingStatusView} code={booking.status} />
              </div>
              <Facts
                items={[
                  ['Başlangıç', formatDateTime(booking.scheduledStart)],
                  ['Bitiş', formatDateTime(booking.scheduledEnd)],
                  ['Tutar', formatMoney(booking.priceMinor, booking.currency)],
                  ['Müşteri', <Id key="c" value={booking.customerId} />],
                  ['Sağlayıcı', <Id key="p" value={booking.providerId} />],
                  ['Hizmet', <Id key="s" value={booking.serviceId} />],
                ]}
              />
              <div className={styles.row}>
                <Link href={`/odemeler?bookingId=${encodeURIComponent(booking.id)}`}>Ödemesi</Link>
              </div>
            </Card>
          )}
        />
      </div>
    </AppShell>
  );
}
