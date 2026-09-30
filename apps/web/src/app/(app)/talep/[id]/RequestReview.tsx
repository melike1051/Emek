'use client';

import { ApiError, catalogApi, requestsApi, type BookingRequest } from '@emek/api-client';
import { Badge, Button, Card, ErrorState, Overline, Skeleton } from '@emek/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RequestForm } from '@/components/RequestForm';
import { RequireCustomer } from '@/components/RequireCustomer';
import { formatRange, needsReview } from '@/lib/booking';
import { toDisplayError } from '@/lib/errors';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { useApi } from '@/providers/AppProviders';
import flow from '../../flow.module.css';
import styles from '../../page.module.css';

/** Talep özeti: ayrıştırma sonucunu gözden geçir → düzelt (yeni talep) ya da eşleştir. */
export function RequestReview({ requestId }: { requestId: string }) {
  return (
    <AppShell title="Talebiniz">
      <RequireCustomer>
        <Review requestId={requestId} />
      </RequireCustomer>
    </AppShell>
  );
}

function Review({ requestId }: { requestId: string }) {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();
  const [editing, setEditing] = useState(false);

  const request = useQuery({
    queryKey: ['booking-requests', requestId],
    queryFn: () => requestsApi(api).get(requestId),
  });
  const services = useQuery({
    queryKey: ['catalog', 'services'],
    queryFn: () => catalogApi(api).services(),
  });

  const toResult = () => router.push(`/talep/${requestId}/eslesme`);
  const match = useMutation({
    mutationFn: () => requestsApi(api).match(requestId, idempotency.current()),
    onSuccess: (result) => {
      idempotency.rotate();
      queryClient.setQueryData(['booking-requests', requestId, 'match'], result);
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      toResult();
    },
    onError: (error) => {
      // Talep daha önce eşleştirilmiş (ör. başka sekmede): sonuç ekranı zaten doğru yer.
      if (error instanceof ApiError && error.code === 'MATCHING_ALREADY_COMPLETED') toResult();
    },
  });

  if (request.isPending) return <Skeleton lines={4} label="Talep yükleniyor" />;
  if (request.isError) {
    return <ErrorState {...toDisplayError(request.error)} onRetry={() => void request.refetch()} />;
  }

  const data: BookingRequest = request.data;
  const service = services.data?.find((s) => s.id === data.serviceId);

  if (editing) {
    return (
      <Card>
        <Overline>Talebi düzelt</Overline>
        <p className={flow.small}>Düzeltilen bilgilerle yeni bir talep oluşturulur.</p>
        <div style={{ marginTop: 'var(--space-sm)' }}>
          <RequestForm
            addressId={data.addressId}
            initial={data}
            onCreated={(created) => {
              setEditing(false);
              router.replace(`/talep/${created.id}`);
            }}
          />
        </div>
        <Button variant="ghost" onClick={() => setEditing(false)}>
          Vazgeç
        </Button>
      </Card>
    );
  }

  const lowConfidence = needsReview(data.parserConfidence);
  const matchError =
    match.error instanceof ApiError && match.error.code === 'MATCHING_ALREADY_COMPLETED'
      ? null
      : match.error;

  return (
    <div className={flow.stack}>
      <Card>
        <div className={flow.between}>
          <Overline>{data.parserVersion ? 'Anladığımız' : 'Talebiniz'}</Overline>
          {data.parserVersion ? <Badge tone="neutral">Akıllı talep</Badge> : null}
        </div>
        {lowConfidence ? (
          <p className={flow.notice} role="status" style={{ marginTop: 'var(--space-sm)' }}>
            Talebinizi doğru anladığımızdan emin değiliz. Lütfen bilgileri kontrol edin; gerekirse
            düzeltin.
          </p>
        ) : null}
        <dl className={styles.dl} style={{ marginTop: 'var(--space-sm)' }}>
          <dt>Hizmet</dt>
          <dd>{service?.name ?? (services.isPending ? '…' : 'Bilinmeyen hizmet')}</dd>
          <dt>Zaman aralığı</dt>
          <dd>{formatRange(data.preferredStart, data.preferredEnd)}</dd>
          <dt>Süre</dt>
          <dd>{data.durationMinutes} dakika</dd>
        </dl>
      </Card>
      {matchError ? <ErrorState {...toDisplayError(matchError)} /> : null}
      <Button size="lg" fullWidth loading={match.isPending} onClick={() => match.mutate()}>
        Sağlayıcı bul
      </Button>
      <Button variant="ghost" onClick={() => setEditing(true)} disabled={match.isPending}>
        Bilgileri düzelt
      </Button>
    </div>
  );
}
