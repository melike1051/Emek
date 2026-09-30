'use client';

/** Müşteri ve sağlayıcı randevu ekranlarının ortak kartları (tek davranış, iki bakış). */

import { bookingsApi, type Booking, type DisputeReason } from '@emek/api-client';
import { Badge, Button, Card, ErrorState, Overline, Skeleton, TextArea } from '@emek/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  DISPUTE_REASON_LABELS,
  DISPUTE_STATUS_LABELS,
  bookingStatusView,
  formatDateTime,
} from '@/lib/booking';
import { toDisplayError } from '@/lib/errors';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { useApi } from '@/providers/AppProviders';
import flow from '@/app/(app)/flow.module.css';

/**
 * Rezervasyon komutu: aynı eylemin aynı gövdeyle yeniden denemesi aynı `Idempotency-Key`'i
 * taşır; gövde (`signature`, ör. iptal gerekçesi) değişirse yeni anahtar alır. Başarıda anahtar
 * yenilenir ve randevu önbelleği güncellenir.
 */
export function useBookingMutation<T>(
  bookingId: string,
  run: (key: string) => Promise<T>,
  signature = '',
) {
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();
  return useMutation({
    mutationFn: () => run(idempotency.current(signature)),
    onSuccess: async (result) => {
      idempotency.rotate();
      if (isBooking(result)) queryClient.setQueryData(['bookings', bookingId], result);
      await queryClient.invalidateQueries({ queryKey: ['bookings'] });
    },
  });
}

export function isBooking(value: unknown): value is Booking {
  return typeof value === 'object' && value !== null && 'scheduledStart' in value;
}

/** İki adımlı onay: yıkıcı/geri alınamaz komutlar tek tıkla gönderilmez. */
export function ConfirmStep({
  label,
  confirmLabel,
  variant = 'primary',
  pending,
  onConfirm,
  children,
}: {
  label: string;
  confirmLabel: string;
  variant?: 'primary' | 'danger';
  pending: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button variant={variant === 'danger' ? 'ghost' : 'primary'} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <div className={flow.stack}>
      {children}
      <div className={flow.row}>
        <Button variant={variant} loading={pending} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" onClick={() => setAsking(false)} disabled={pending}>
          Vazgeç
        </Button>
      </div>
    </div>
  );
}

const REASONS = Object.keys(DISPUTE_REASON_LABELS) as DisputeReason[];

export function DisputesCard({ bookingId, canOpen }: { bookingId: string; canOpen: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();
  const [opening, setOpening] = useState(false);
  const [reason, setReason] = useState<DisputeReason>('SERVICE_QUALITY');
  const [description, setDescription] = useState('');

  const disputes = useQuery({
    queryKey: ['bookings', bookingId, 'disputes'],
    queryFn: () => bookingsApi(api).disputes(bookingId),
  });
  const open = useMutation({
    mutationFn: () => {
      const body = {
        reason,
        ...(description.trim() ? { description: description.trim() } : {}),
      };
      return bookingsApi(api).openDispute(
        bookingId,
        body,
        idempotency.current(JSON.stringify(body)),
      );
    },
    onSuccess: async () => {
      idempotency.rotate();
      setOpening(false);
      await queryClient.invalidateQueries({ queryKey: ['bookings'] });
    },
  });

  const list = disputes.data ?? [];
  const hasOpen = list.some((d) => d.status === 'OPEN' || d.status === 'UNDER_REVIEW');
  if (list.length === 0 && !canOpen) return null;

  return (
    <Card>
      <Overline>İtiraz</Overline>
      {disputes.isError ? (
        <ErrorState {...toDisplayError(disputes.error)} onRetry={() => void disputes.refetch()} />
      ) : null}
      {list.length > 0 ? (
        <ul className={flow.list} style={{ marginTop: 'var(--space-sm)' }}>
          {list.map((dispute) => (
            <li key={dispute.id}>
              <div className={flow.between}>
                <strong>{DISPUTE_REASON_LABELS[dispute.reason] ?? dispute.reason}</strong>
                <Badge
                  tone={
                    dispute.status === 'OPEN' || dispute.status === 'UNDER_REVIEW'
                      ? 'danger'
                      : 'neutral'
                  }
                >
                  {DISPUTE_STATUS_LABELS[dispute.status] ?? dispute.status}
                </Badge>
              </div>
              <p className={flow.small}>{formatDateTime(dispute.createdAt)}</p>
              {dispute.resolution ? <p>{dispute.resolution}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canOpen && !hasOpen ? (
        opening ? (
          <form
            className={flow.stack}
            style={{ marginTop: 'var(--space-sm)' }}
            aria-label="İtiraz aç"
            onSubmit={(event) => {
              event.preventDefault();
              open.mutate();
            }}
          >
            <p className={flow.small}>
              İtiraz açıldığında ödeme, karar verilene kadar kimseye aktarılmaz.
            </p>
            <div>
              <label htmlFor="dispute-reason" className={flow.fieldLabel}>
                Konu
              </label>
              <select
                id="dispute-reason"
                className={flow.select}
                value={reason}
                onChange={(event) => setReason(event.target.value as DisputeReason)}
              >
                {REASONS.map((value) => (
                  <option key={value} value={value}>
                    {DISPUTE_REASON_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <TextArea
              label="Ne oldu?"
              value={description}
              maxLength={2000}
              rows={4}
              onChange={(event) => setDescription(event.target.value)}
            />
            {open.error ? <ErrorState {...toDisplayError(open.error)} /> : null}
            <div className={flow.row}>
              <Button type="submit" variant="danger" loading={open.isPending}>
                İtirazı gönder
              </Button>
              <Button variant="ghost" onClick={() => setOpening(false)} disabled={open.isPending}>
                Vazgeç
              </Button>
            </div>
          </form>
        ) : (
          <div style={{ marginTop: 'var(--space-sm)' }}>
            <Button variant="secondary" onClick={() => setOpening(true)}>
              Sorun bildir / itiraz aç
            </Button>
          </div>
        )
      ) : null}
    </Card>
  );
}

export function HistoryCard({
  bookingId,
  labelFor = (status) => bookingStatusView(status).label,
}: {
  bookingId: string;
  /** Durum etiketi bakışa göre değişir (müşteri/sağlayıcı). */
  labelFor?: (status: string) => string;
}) {
  const api = useApi();
  const history = useQuery({
    queryKey: ['bookings', bookingId, 'history'],
    queryFn: () => bookingsApi(api).history(bookingId),
  });
  return (
    <Card>
      <Overline>Zaman çizelgesi</Overline>
      {history.isPending ? (
        <Skeleton lines={3} label="Geçmiş yükleniyor" />
      ) : history.isError ? (
        <ErrorState {...toDisplayError(history.error)} onRetry={() => void history.refetch()} />
      ) : (
        <ol className={flow.timeline}>
          {[...history.data].reverse().map((entry) => (
            <li key={`${entry.toStatus}-${entry.createdAt}`}>
              <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
              {labelFor(entry.toStatus)}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
