'use client';

import type { Payment, PaymentStatus } from '@emek/api-client';
import { Card, TextField } from '@emek/ui';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ActionPanel } from '@/components/ActionPanel';
import { AppShell } from '@/components/AppShell';
import { CursorList, useCursorList } from '@/components/CursorList';
import { Facts, FilterBar, Id, SelectFilter } from '@/components/Filters';
import { IdFilter } from '@/components/IdFilter';
import { StatusBadge } from '@/components/StatusBadge';
import styles from '@/components/admin.module.css';
import { formatDateTime, formatMoney, parseMoneyToMinor, uuidOrUndefined } from '@/lib/format';
import { PAYMENT_STATUSES, paymentStatusView } from '@/lib/labels';
import { useAdminApi } from '@/providers/AppProviders';

/**
 * Backend'in yetkilendirmeyi canlı saydığı durumlar (payment-status.ts `AUTHORIZED_PAYMENT_STATUSES`).
 * Yalnızca hangi düğmenin **gösterileceğini** belirler; karar ve bloklar (açık uyuşmazlık,
 * güvenlik askısı, süre) backend'dedir ve reddi mesajıyla gösterilir.
 */
const HOLDS_AUTHORIZATION: ReadonlySet<string> = new Set([
  'AUTHORIZED',
  'HELD',
  'SERVICE_COMPLETED',
  'RELEASE_PENDING',
]);
const NOT_REFUNDABLE: ReadonlySet<string> = new Set([
  'CREATED',
  'FAILED',
  'REFUNDED',
  'AUTHORIZATION_EXPIRED',
]);

export function PaymentsScreen() {
  const api = useAdminApi();
  const [status, setStatus] = useState('');
  // `?bookingId=` randevu listesinden gelir; yalnızca başlangıç değeridir.
  const initialBooking = useSearchParams().get('bookingId') ?? '';
  const [booking, setBooking] = useState(initialBooking);
  const filters = {
    status: (status || undefined) as PaymentStatus | undefined,
    bookingId: uuidOrUndefined(booking),
  };
  const query = useCursorList(['payments', filters], (cursor) =>
    api.payments.list({ ...filters, cursor }),
  );

  return (
    <AppShell title="Ödemeler">
      <div className={styles.stack}>
        <FilterBar>
          <SelectFilter
            label="Durum"
            value={status}
            allLabel="Tümü"
            options={PAYMENT_STATUSES.map((value) => ({
              value,
              label: `${paymentStatusView(value).label} (${value})`,
            }))}
            onChange={setStatus}
          />
          <IdFilter label="Randevu kimliği" value={booking} onChange={setBooking} />
        </FilterBar>
        <CursorList
          query={query}
          itemKey={(payment) => payment.id}
          emptyTitle="Ödeme bulunamadı"
          renderItem={(payment) => <PaymentCard payment={payment} />}
        />
      </div>
    </AppShell>
  );
}

function PaymentCard({ payment }: { payment: Payment }) {
  const api = useAdminApi();
  // Serbest bırakma/iade randevu durumunu da değiştirir (ör. `SETTLED`).
  const invalidate = [['payments'], ['bookings'], ['analytics', 'reconciliation']];
  const [amount, setAmount] = useState('');
  const amountMinor = amount.trim() === '' ? undefined : parseMoneyToMinor(amount);
  const remaining = BigInt(payment.amountMinor) - BigInt(payment.refundedMinor);

  return (
    <Card>
      <div className={styles.between}>
        <div>
          <p className={styles.metric}>{formatMoney(payment.amountMinor, payment.currency)}</p>
          <p className={styles.small}>
            Ödeme <Id value={payment.id} /> · randevu <Id value={payment.bookingId} />
          </p>
        </div>
        <StatusBadge view={paymentStatusView} code={payment.status} />
      </div>
      <Facts
        items={[
          ['İade edilen', formatMoney(payment.refundedMinor, payment.currency)],
          ['Yetki bitişi', formatDateTime(payment.authorizationExpiresAt)],
          ['Serbest bırakılma', formatDateTime(payment.releasedAt)],
        ]}
      />
      <div className={styles.row}>
        {HOLDS_AUTHORIZATION.has(payment.status) ? (
          <>
            <ActionPanel
              trigger="Serbest bırak"
              variant="primary"
              title={`${formatMoney(payment.amountMinor, payment.currency)} sağlayıcıya serbest bırakılsın mı?`}
              description="Para ödeme kuruluşunda tahsil edilip sağlayıcıya aktarılır. Açık uyuşmazlık, güvenlik bekletmesi veya süresi dolmuş yetki varsa backend reddeder."
              confirmLabel="Serbest bırak"
              acknowledge="Uyuşmazlık penceresinin geçtiğini ve hizmetin tamamlandığını kontrol ettim."
              run={({ idempotencyKey }) => api.payments.release(payment.id, idempotencyKey)}
              invalidate={invalidate}
            />
            <ActionPanel
              trigger="Yetkiyi yenile"
              title="Yetkilendirmeyi yenile"
              description="Süresi yaklaşan yetkilendirme ödeme kuruluşunda yenilenir; müşteriden yeniden tahsilat yapılmaz."
              confirmLabel="Yenile"
              run={({ idempotencyKey }) => api.payments.reauthorize(payment.id, idempotencyKey)}
              invalidate={invalidate}
            />
          </>
        ) : null}
        {!NOT_REFUNDABLE.has(payment.status) && remaining > 0n ? (
          <ActionPanel
            trigger="İade et"
            variant="danger"
            title="İade"
            description={`Kalan iade edilebilir tutar: ${formatMoney(remaining.toString(), payment.currency)}. Tutar boş bırakılırsa tamamı iade edilir.`}
            confirmLabel="İade et"
            acknowledge="İade müşteriye geri ödenir ve geri alınamaz."
            reason={{ label: 'İade gerekçesi', required: true, maxLength: 160 }}
            extra={
              <TextField
                label="Tutar (₺, isteğe bağlı)"
                inputMode="decimal"
                placeholder="ör. 150,00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                error={amountMinor === null ? 'Geçerli bir tutar girin (ör. 150,00).' : undefined}
              />
            }
            extraValid={amountMinor !== null}
            payloadSignature={amountMinor ?? ''}
            run={({ reason, idempotencyKey }) =>
              api.payments.refund(
                payment.id,
                { reason: reason ?? '', ...(amountMinor ? { amountMinor } : {}) },
                idempotencyKey,
              )
            }
            invalidate={invalidate}
            onDone={() => setAmount('')}
          />
        ) : null}
      </div>
    </Card>
  );
}
