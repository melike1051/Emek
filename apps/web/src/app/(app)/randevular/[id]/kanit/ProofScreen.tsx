'use client';

import { documentsApi } from '@emek/api-client';
import { EmptyState, ErrorState, Skeleton } from '@emek/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { EvidenceCard } from '@/components/EvidenceCard';
import { toDisplayError } from '@/lib/errors';
import { useApi } from '@/providers/AppProviders';
import flow from '../../../flow.module.css';

/**
 * Before/after kanıtları. `sha256` storage'daki nesneden okunmuştur (istemci beyanı değildir).
 * İmzalı URL kısa ömürlüdür: sorgu önbelleğine yazılmaz, loglanmaz; tıklamada alınır ve hemen açılır.
 */
export function ProofScreen({ bookingId }: { bookingId: string }) {
  return (
    <AppShell title="Dijital İspat">
      <Documents bookingId={bookingId} />
    </AppShell>
  );
}

function Documents({ bookingId }: { bookingId: string }) {
  const api = useApi();
  const docs = useQuery({
    queryKey: ['bookings', bookingId, 'documents'],
    queryFn: () => documentsApi(api).listForBooking(bookingId),
  });

  const back = <Link href={`/randevular/${bookingId}`}>Randevuya dön</Link>;
  if (docs.isPending) return <Skeleton lines={3} label="Kanıtlar yükleniyor" />;
  if (docs.isError) {
    return <ErrorState {...toDisplayError(docs.error)} onRetry={() => void docs.refetch()} />;
  }
  const uploaded = docs.data.filter((d) => d.status === 'AVAILABLE');
  if (uploaded.length === 0) {
    return (
      <EmptyState
        title="Henüz kanıt yüklenmedi"
        description="Sağlayıcı hizmet öncesi ve sonrası fotoğrafları yüklediğinde burada görünür."
        action={back}
      />
    );
  }
  return (
    <div className={flow.stack}>
      <ul className={flow.list}>
        {uploaded.map((doc) => (
          <li key={doc.id}>
            <EvidenceCard doc={doc} />
          </li>
        ))}
      </ul>
      {back}
    </div>
  );
}
