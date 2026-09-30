'use client';

import { requestsApi } from '@emek/api-client';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Overline, Skeleton } from '@emek/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { RequireCustomer } from '@/components/RequireCustomer';
import { explanationText, formatRange } from '@/lib/booking';
import { toDisplayError } from '@/lib/errors';
import { useApi } from '@/providers/AppProviders';
import flow from '../../../flow.module.css';

/**
 * Eşleşme sonucu. Backend yalnızca **seçilen** sağlayıcıyı döner (T-19): diğer adaylar ve ham
 * skorlar müşteriye verilmez. Gerekçeler kapalı kod kümesinden bu ekranda metne çevrilir.
 */
export function MatchResultScreen({ requestId }: { requestId: string }) {
  return (
    <AppShell title="Eşleşme">
      <RequireCustomer>
        <Result requestId={requestId} />
      </RequireCustomer>
    </AppShell>
  );
}

function Result({ requestId }: { requestId: string }) {
  const api = useApi();
  const router = useRouter();
  const result = useQuery({
    queryKey: ['booking-requests', requestId, 'match'],
    queryFn: () => requestsApi(api).matchResult(requestId),
  });

  if (result.isPending) return <Skeleton lines={4} label="Eşleşme yükleniyor" />;
  if (result.isError) {
    return <ErrorState {...toDisplayError(result.error)} onRetry={() => void result.refetch()} />;
  }

  const data = result.data;
  if (data.status === 'NO_CANDIDATE' || !data.bookingId) {
    return (
      <EmptyState
        title="Şu an uygun sağlayıcı bulamadık"
        description="Farklı bir zaman aralığı ya da tarih seçerek yeni bir talep oluşturabilirsiniz."
        action={<Link href="/">Yeni talep oluştur</Link>}
      />
    );
  }

  const reasons = data.explanation
    .map((reason) => explanationText(reason.code, reason.value))
    .filter((text): text is string => text !== null);

  return (
    <div className={flow.stack}>
      <Card>
        <Overline>Sizin için seçtiğimiz sağlayıcı</Overline>
        <div className={flow.row} style={{ marginTop: 'var(--space-sm)' }}>
          <Avatar name={data.providerName ?? ''} size="lg" />
          <div>
            <h2>{data.providerName ?? 'Sağlayıcı'}</h2>
            {data.scheduledStart && data.scheduledEnd ? (
              <p className={flow.muted}>{formatRange(data.scheduledStart, data.scheduledEnd)}</p>
            ) : null}
          </div>
        </div>
        {data.degraded ? (
          <p className={flow.notice} style={{ marginTop: 'var(--space-sm)' }}>
            Eşleştirme sınırlı modda yapıldı; sonuç yine de uygunluk kurallarından geçti.
          </p>
        ) : null}
        {reasons.length > 0 ? (
          <>
            <p style={{ marginTop: 'var(--space-md)' }}>
              <Badge tone="trust">Neden bu sağlayıcı?</Badge>
            </p>
            <ul className={flow.reasons}>
              {reasons.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </>
        ) : null}
        {data.providerId ? (
          <p style={{ marginTop: 'var(--space-md)' }}>
            <Link href={`/saglayici/${data.providerId}`}>Değerlendirmelerini gör</Link>
          </p>
        ) : null}
      </Card>
      <p className={flow.small}>
        Sağlayıcı talebinizi onayladıktan sonra ödeme adımına geçeceksiniz.
      </p>
      <Button size="lg" fullWidth onClick={() => router.push(`/randevular/${data.bookingId}`)}>
        Randevuya git
      </Button>
    </div>
  );
}
