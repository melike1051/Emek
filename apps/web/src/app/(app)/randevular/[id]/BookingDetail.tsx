'use client';

import { ApiError, bookingsApi, catalogApi, type Booking } from '@emek/api-client';
import { Badge, Button, Card, ErrorState, Overline, Skeleton, TextArea } from '@emek/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AppShell } from '@/components/AppShell';
import { RequireCustomer } from '@/components/RequireCustomer';
import {
  ConfirmStep,
  DisputesCard,
  HistoryCard,
  useBookingMutation,
} from '@/components/BookingCards';
import { BookingStatusBadge } from '@/components/StatusBadge';
import { customerActions, formatMoney, formatRange, paymentStatusView } from '@/lib/booking';
import { toDisplayError } from '@/lib/errors';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { useApi } from '@/providers/AppProviders';
import flow from '../../flow.module.css';
import styles from '../../page.module.css';

const PROOF_VISIBLE = new Set([
  'CHECKED_IN',
  'IN_PROGRESS',
  'CHECKED_OUT',
  'CUSTOMER_CONFIRMED',
  'COMPLETED',
  'SETTLED',
  'DISPUTED',
  'SAFETY_HOLD',
]);

export function BookingDetail({ bookingId }: { bookingId: string }) {
  return (
    <AppShell title="Randevu">
      <RequireCustomer>
        <Detail bookingId={bookingId} />
      </RequireCustomer>
    </AppShell>
  );
}

function Detail({ bookingId }: { bookingId: string }) {
  const api = useApi();
  const bookings = bookingsApi(api);
  const booking = useQuery({
    queryKey: ['bookings', bookingId],
    queryFn: () => bookings.get(bookingId),
  });
  const services = useQuery({
    queryKey: ['catalog', 'services'],
    queryFn: () => catalogApi(api).services(),
  });

  if (booking.isPending) return <Skeleton lines={5} label="Randevu yükleniyor" />;
  if (booking.isError) {
    return <ErrorState {...toDisplayError(booking.error)} onRetry={() => void booking.refetch()} />;
  }

  const data = booking.data;
  const actions = customerActions(data.status);
  const service = services.data?.find((s) => s.id === data.serviceId);

  return (
    <div className={flow.stack}>
      <Card>
        <div className={flow.between}>
          <div>
            <Overline>Randevu</Overline>
            <h2>{service?.name ?? 'Hizmet'}</h2>
          </div>
          <BookingStatusBadge status={data.status} />
        </div>
        <dl className={styles.dl} style={{ marginTop: 'var(--space-sm)' }}>
          <dt>Zaman</dt>
          <dd>{formatRange(data.scheduledStart, data.scheduledEnd)}</dd>
          <dt>Tutar</dt>
          <dd>{formatMoney(data.priceMinor, data.currency)}</dd>
        </dl>
        <div className={flow.row} style={{ marginTop: 'var(--space-md)' }}>
          {data.providerId ? (
            <Link href={`/saglayici/${data.providerId}`}>Sağlayıcının değerlendirmeleri</Link>
          ) : null}
          {actions.hasSafetySession ? (
            <Link href={`/randevular/${bookingId}/guvenlik`}>Güvenlik & oturum</Link>
          ) : null}
          {PROOF_VISIBLE.has(data.status) ? (
            <Link href={`/randevular/${bookingId}/kanit`}>Dijital ispat</Link>
          ) : null}
        </div>
      </Card>

      <PaymentCard booking={data} />
      {actions.canConfirmService ? <ConfirmServiceCard bookingId={bookingId} /> : null}
      {actions.canReview ? <ReviewCard bookingId={bookingId} /> : null}
      <DisputesCard bookingId={bookingId} canOpen={actions.canDispute} />
      <HistoryCard bookingId={bookingId} />
      {actions.canCancel ? <CancelCard bookingId={bookingId} /> : null}
    </div>
  );
}

/**
 * Ödeme lisanslı kuruluş üzerinden yetkilendirilir; Emek parayı tutmaz (CLAUDE.md §4 Payment).
 * Gövde boştur — tutar sunucuda rezervasyondan okunur.
 * TODO(faz-15/psp): gerçek sağlayıcıda `clientToken` ile barındırılan ödeme/3DS sayfası açılır;
 * sağlayıcı seçilene kadar yetkilendirme sunucu tarafında senkron tamamlanır (mock adapter).
 * TODO(legal): ödeme/emanet açıklama metni hukuki onaydan geçmeli.
 */
function PaymentCard({ booking }: { booking: Booking }) {
  const api = useApi();
  const showPayment = !['REQUESTED', 'MATCHED', 'PROVIDER_PENDING', 'CANCELLED'].includes(
    booking.status,
  );
  const payment = useQuery({
    queryKey: ['bookings', booking.id, 'payment'],
    queryFn: () => bookingsApi(api).payment(booking.id),
    enabled: showPayment,
  });
  const authorize = useBookingMutation(booking.id, (key) =>
    bookingsApi(api).authorizePayment(booking.id, key),
  );

  if (booking.status === 'PROVIDER_PENDING') {
    return (
      <Card tone="muted">
        <Overline>Ödeme</Overline>
        <p className={flow.small}>
          Sağlayıcı randevuyu onayladığında ödemeyi yetkilendirmeniz istenecek. O zamana kadar
          kartınızdan tutar alınmaz.
        </p>
      </Card>
    );
  }
  if (!showPayment) return null;

  const alreadyAuthorized =
    authorize.error instanceof ApiError && authorize.error.code === 'PAYMENT_ALREADY_AUTHORIZED';

  return (
    <Card>
      <Overline>Ödeme</Overline>
      {payment.isPending ? (
        <Skeleton lines={1} label="Ödeme bilgisi yükleniyor" />
      ) : payment.isError ? (
        <ErrorState {...toDisplayError(payment.error)} onRetry={() => void payment.refetch()} />
      ) : payment.data ? (
        <dl className={styles.dl} style={{ marginTop: 'var(--space-sm)' }}>
          <dt>Durum</dt>
          <dd>
            <Badge tone={paymentStatusView(payment.data.status).tone}>
              {paymentStatusView(payment.data.status).label}
            </Badge>
          </dd>
          <dt>Tutar</dt>
          <dd>{formatMoney(payment.data.amountMinor, payment.data.currency)}</dd>
          {payment.data.refundedMinor !== '0' ? (
            <>
              <dt>İade</dt>
              <dd>{formatMoney(payment.data.refundedMinor, payment.data.currency)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {payment.data?.status === 'AUTHORIZATION_EXPIRED' ? (
        <p className={flow.notice} style={{ marginTop: 'var(--space-sm)' }}>
          Ödeme yetkisinin süresi doldu. Yeniden yetkilendirme destek ekibimiz tarafından
          başlatılır; sizinle iletişime geçeceğiz.
        </p>
      ) : null}

      {booking.status === 'CONFIRMED' ? (
        <div className={flow.stack} style={{ marginTop: 'var(--space-sm)' }}>
          <p className={flow.small}>
            Tutar lisanslı ödeme kuruluşu tarafından kartınızda bloke edilir; hizmet tamamlanıp
            onaylanana kadar sağlayıcıya aktarılmaz.
          </p>
          {authorize.error && !alreadyAuthorized ? (
            <ErrorState {...toDisplayError(authorize.error)} />
          ) : null}
          <Button
            size="lg"
            fullWidth
            loading={authorize.isPending}
            onClick={() => authorize.mutate()}
          >
            {`${formatMoney(booking.priceMinor, booking.currency)} ödemeyi onayla`}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function ConfirmServiceCard({ bookingId }: { bookingId: string }) {
  const api = useApi();
  const confirm = useBookingMutation(bookingId, (key) =>
    bookingsApi(api).transition(bookingId, 'CUSTOMER_CONFIRMED', key),
  );
  return (
    <Card>
      <Overline>Hizmet tamamlandı mı?</Overline>
      <p className={flow.small} style={{ margin: 'var(--space-sm) 0' }}>
        Sağlayıcı hizmeti bitirdiğini bildirdi. Onayınızdan sonra itiraz penceresi başlar; bir sorun
        varsa onaylamadan önce itiraz açabilirsiniz.
      </p>
      {confirm.error ? <ErrorState {...toDisplayError(confirm.error)} /> : null}
      <ConfirmStep
        label="Hizmeti onayla"
        confirmLabel="Evet, hizmet tamamlandı"
        pending={confirm.isPending}
        onConfirm={() => confirm.mutate()}
      />
    </Card>
  );
}

function CancelCard({ bookingId }: { bookingId: string }) {
  const api = useApi();
  const [reason, setReason] = useState('');
  const cancel = useBookingMutation(
    bookingId,
    (key) => bookingsApi(api).cancel(bookingId, reason.trim() || undefined, key),
    reason.trim(),
  );
  return (
    <Card tone="muted">
      {cancel.error ? <ErrorState {...toDisplayError(cancel.error)} /> : null}
      <ConfirmStep
        label="Randevuyu iptal et"
        confirmLabel="İptal et"
        variant="danger"
        pending={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      >
        <TextArea
          label="İptal gerekçesi (isteğe bağlı)"
          value={reason}
          maxLength={160}
          rows={2}
          onChange={(event) => setReason(event.target.value)}
        />
      </ConfirmStep>
    </Card>
  );
}

function ReviewCard({ bookingId }: { bookingId: string }) {
  const api = useApi();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const idempotency = useIdempotencyKey();
  const submit = useMutation({
    mutationFn: () => {
      const body = { rating, ...(comment.trim() ? { comment: comment.trim() } : {}) };
      return bookingsApi(api).createReview(
        bookingId,
        body,
        idempotency.current(JSON.stringify(body)),
      );
    },
    onSuccess: () => idempotency.rotate(),
  });

  const already = submit.error instanceof ApiError && submit.error.code === 'REVIEW_ALREADY_EXISTS';
  if (submit.isSuccess || already) {
    return (
      <Card tone="muted">
        <Overline>Değerlendirme</Overline>
        <p style={{ marginTop: 'var(--space-sm)' }}>Değerlendirmeniz için teşekkürler.</p>
      </Card>
    );
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (rating >= 1) submit.mutate();
  }

  return (
    <Card>
      <form className={flow.stack} onSubmit={onSubmit} aria-label="Değerlendirme">
        <Overline>Hizmeti değerlendirin</Overline>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className={flow.small}>Puanınız</legend>
          <div className={flow.stars} role="radiogroup" aria-label="Puan">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={rating === value}
                aria-label={`${value} yıldız`}
                className={flow.star}
                data-filled={rating >= value}
                onClick={() => setRating(value)}
              >
                ★
              </button>
            ))}
          </div>
        </fieldset>
        <TextArea
          label="Yorumunuz (isteğe bağlı)"
          value={comment}
          maxLength={2000}
          rows={3}
          onChange={(event) => setComment(event.target.value)}
        />
        {submit.error ? <ErrorState {...toDisplayError(submit.error)} /> : null}
        <Button type="submit" loading={submit.isPending} disabled={rating < 1}>
          Gönder
        </Button>
      </form>
    </Card>
  );
}
