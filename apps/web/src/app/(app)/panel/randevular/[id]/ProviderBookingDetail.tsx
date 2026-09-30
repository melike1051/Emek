'use client';

import { bookingsApi, catalogApi, documentsApi, type Booking } from '@emek/api-client';
import { Badge, Card, EmptyState, ErrorState, Overline, Skeleton, TextArea } from '@emek/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import {
  ConfirmStep,
  DisputesCard,
  HistoryCard,
  useBookingMutation,
} from '@/components/BookingCards';
import { EvidenceCard } from '@/components/EvidenceCard';
import { EvidenceUpload } from '@/components/EvidenceUpload';
import { formatMoney, formatRange } from '@/lib/booking';
import { toDisplayError } from '@/lib/errors';
import { providerActions, providerBookingStatusView, type NextStep } from '@/lib/provider';
import { useSession } from '@/providers/AppProviders';
import flow from '../../../flow.module.css';
import styles from '../../../page.module.css';

const DISPUTABLE: ReadonlySet<string> = new Set(['CHECKED_OUT', 'CUSTOMER_CONFIRMED', 'COMPLETED']);
const EVIDENCE_VISIBLE: ReadonlySet<string> = new Set([
  'CHECKED_IN',
  'IN_PROGRESS',
  'CHECKED_OUT',
  'CUSTOMER_CONFIRMED',
  'COMPLETED',
  'SETTLED',
  'DISPUTED',
  'SAFETY_HOLD',
]);

export function ProviderBookingDetail({ bookingId }: { bookingId: string }) {
  return (
    <AppShell title="Randevu">
      <Detail bookingId={bookingId} />
    </AppShell>
  );
}

function Detail({ bookingId }: { bookingId: string }) {
  const { api, session } = useSession();
  const booking = useQuery({
    queryKey: ['bookings', bookingId],
    queryFn: () => bookingsApi(api).get(bookingId),
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
  // Aynı hesap bu randevunun müşterisi olabilir (farklı profil): sağlayıcı ekranı yalnızca
  // sağlayıcısı olduğu randevuyu yönetir. Yetki kaynağı backend'dir; bu yalnızca yönlendirme.
  if (data.providerId !== session?.userId) {
    return (
      <EmptyState
        title="Bu randevuyu siz vermiyorsunuz"
        action={<Link href={`/randevular/${bookingId}`}>Müşteri olarak görüntüle</Link>}
      />
    );
  }

  const actions = providerActions(data.status);
  const status = providerBookingStatusView(data.status);
  const service = services.data?.find((s) => s.id === data.serviceId);

  return (
    <div className={flow.stack}>
      <Card>
        <div className={flow.between}>
          <div>
            <Overline>Randevu</Overline>
            <h2>{service?.name ?? 'Hizmet'}</h2>
          </div>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <dl className={styles.dl} style={{ marginTop: 'var(--space-sm)' }}>
          <dt>Zaman</dt>
          <dd>{formatRange(data.scheduledStart, data.scheduledEnd)}</dd>
          <dt>Tutar</dt>
          <dd>{formatMoney(data.priceMinor, data.currency)}</dd>
        </dl>
        <ServiceAddress bookingId={bookingId} visibility={actions.address} />
        {actions.hasSafetySession ? (
          <div className={flow.row} style={{ marginTop: 'var(--space-md)' }}>
            <Link href={`/panel/randevular/${bookingId}/oturum`}>Güvenlik & oturum</Link>
          </div>
        ) : null}
      </Card>

      {data.status === 'CONFIRMED' ? (
        <Card tone="muted">
          <p className={flow.small}>
            Randevuyu onayladınız. Müşteri ödemeyi yetkilendirdiğinde randevu planlanır; ödeme
            lisanslı ödeme kuruluşunda tutulur ve hizmet onaylanana kadar aktarılmaz.
          </p>
        </Card>
      ) : null}

      {actions.canRespond ? <RespondCard bookingId={bookingId} /> : null}
      {actions.next ? <NextStepCard booking={data} step={actions.next} /> : null}
      {EVIDENCE_VISIBLE.has(data.status) || actions.uploadable.length > 0 ? (
        <EvidenceSection bookingId={bookingId} booking={data} />
      ) : null}
      <DisputesCard bookingId={bookingId} canOpen={DISPUTABLE.has(data.status)} />
      <HistoryCard
        bookingId={bookingId}
        labelFor={(value) => providerBookingStatusView(value).label}
      />
      {actions.canCancel ? <CancelCard bookingId={bookingId} /> : null}
    </div>
  );
}

/** `PROVIDER_PENDING`: kabul `POST /confirm`, ret ise gerekçeli iptaldir (ayrı ret ucu yok). */
function RespondCard({ bookingId }: { bookingId: string }) {
  const { api } = useSession();
  const [reason, setReason] = useState('');
  const accept = useBookingMutation(bookingId, (key) => bookingsApi(api).confirm(bookingId, key));
  const decline = useBookingMutation(
    bookingId,
    (key) => bookingsApi(api).cancel(bookingId, reason.trim() || undefined, key),
    reason.trim(),
  );
  const error = accept.error ?? decline.error;
  return (
    <Card>
      <Overline>Yeni randevu talebi</Overline>
      <p className={flow.small} style={{ margin: 'var(--space-sm) 0' }}>
        Bu saatte hizmet verebilecek misiniz? Onayladığınızda müşteriden ödeme yetkisi istenir.
      </p>
      {error ? <ErrorState {...toDisplayError(error)} /> : null}
      <div className={flow.stack}>
        <ConfirmStep
          label="Randevuyu kabul et"
          confirmLabel="Evet, kabul ediyorum"
          pending={accept.isPending}
          onConfirm={() => accept.mutate()}
        />
        <ConfirmStep
          label="Reddet"
          confirmLabel="Randevuyu reddet"
          variant="danger"
          pending={decline.isPending}
          onConfirm={() => decline.mutate()}
        >
          <TextArea
            label="Gerekçe (isteğe bağlı)"
            value={reason}
            maxLength={160}
            rows={2}
            onChange={(event) => setReason(event.target.value)}
          />
        </ConfirmStep>
      </div>
    </Card>
  );
}

const ADDRESS_NOTICE = {
  AFTER_PAYMENT: 'Hizmet adresi, müşteri ödemeyi onaylayıp randevu planlandığında görünür.',
  CLOSED: 'Randevu kapandığı için hizmet adresi artık gösterilmiyor.',
} as const;

/**
 * Hizmet adresi (R-102). Backend adresi yalnız planlanmış randevudan check-out'a kadar verir
 * ve her okumayı audit'e yazar; bu yüzden pencere dışında istek atılmaz ve sonuç önbellekte
 * tutulur (her odaklanmada yeni audit kaydı üretilmez). Harita bağlantısı yalnız tıklanınca
 * koordinatı dış servise götürür.
 */
function ServiceAddress({
  bookingId,
  visibility,
}: {
  bookingId: string;
  visibility: 'VISIBLE' | 'AFTER_PAYMENT' | 'CLOSED';
}) {
  const { api } = useSession();
  const address = useQuery({
    queryKey: ['bookings', bookingId, 'address'],
    queryFn: () => bookingsApi(api).address(bookingId),
    enabled: visibility === 'VISIBLE',
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  if (visibility !== 'VISIBLE') {
    return (
      <p className={flow.notice} style={{ marginTop: 'var(--space-sm)' }}>
        {ADDRESS_NOTICE[visibility]}
      </p>
    );
  }
  if (address.isPending) return <Skeleton lines={2} label="Hizmet adresi yükleniyor" />;
  if (address.error) return <ErrorState {...toDisplayError(address.error)} />;

  const { line, district, city, latitude, longitude } = address.data;
  return (
    <dl className={styles.dl} style={{ marginTop: 'var(--space-sm)' }} aria-label="Hizmet adresi">
      <dt>Adres</dt>
      <dd>
        {line}
        <br />
        {district} / {city}
        <br />
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Haritada aç
        </a>
      </dd>
    </dl>
  );
}

function NextStepCard({ booking, step }: { booking: Booking; step: NextStep }) {
  const { api } = useSession();
  const advance = useBookingMutation(
    booking.id,
    (key) => bookingsApi(api).transition(booking.id, step.to, key),
    step.to,
  );
  return (
    <Card>
      <Overline>Sıradaki adım</Overline>
      <p className={flow.small} style={{ margin: 'var(--space-sm) 0' }}>
        {step.hint}
      </p>
      {advance.error ? <ErrorState {...toDisplayError(advance.error)} /> : null}
      {/* Anahtar hedef duruma bağlı: bir adım bitince sonraki adımın onayı sıfırdan başlar. */}
      <ConfirmStep
        key={step.to}
        label={step.label}
        confirmLabel={step.confirmLabel}
        pending={advance.isPending}
        onConfirm={() => advance.mutate()}
      />
    </Card>
  );
}

function EvidenceSection({ bookingId, booking }: { bookingId: string; booking: Booking }) {
  const { api } = useSession();
  const actions = providerActions(booking.status);
  const docs = useQuery({
    queryKey: ['bookings', bookingId, 'documents'],
    queryFn: () => documentsApi(api).listForBooking(bookingId),
  });
  const uploaded = docs.data?.filter((d) => d.status === 'AVAILABLE') ?? [];
  return (
    <Card>
      <Overline>Dijital ispat</Overline>
      <p className={flow.small} style={{ margin: 'var(--space-xs) 0 var(--space-sm)' }}>
        Önce/sonra fotoğrafları olası bir itirazda sizi korur. Müşteri de bu dosyaları görür.
      </p>
      {docs.isPending ? (
        <Skeleton lines={2} label="Kanıtlar yükleniyor" />
      ) : docs.isError ? (
        <ErrorState {...toDisplayError(docs.error)} onRetry={() => void docs.refetch()} />
      ) : uploaded.length > 0 ? (
        <ul className={flow.list}>
          {uploaded.map((doc) => (
            <li key={doc.id}>
              <EvidenceCard doc={doc} />
            </li>
          ))}
        </ul>
      ) : (
        <p className={flow.small}>Henüz dosya eklenmedi.</p>
      )}
      {actions.uploadable.length > 0 ? (
        <div style={{ marginTop: 'var(--space-md)' }}>
          <EvidenceUpload bookingId={bookingId} types={actions.uploadable} />
        </div>
      ) : null}
    </Card>
  );
}

function CancelCard({ bookingId }: { bookingId: string }) {
  const { api } = useSession();
  const [reason, setReason] = useState('');
  const cancel = useBookingMutation(
    bookingId,
    (key) => bookingsApi(api).cancel(bookingId, reason.trim() || undefined, key),
    reason.trim(),
  );
  return (
    <Card tone="muted">
      <p className={flow.small} style={{ marginBottom: 'var(--space-sm)' }}>
        Son dakika iptalleri müşteriyi zor durumda bırakır. Hizmet başladıktan sonra iptal yalnızca
        destek ekibi üzerinden yapılabilir.
      </p>
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
