'use client';

import { bookingsApi } from '@emek/api-client';
import { Card, EmptyState, ErrorState, Overline, Skeleton } from '@emek/ui';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { formatDateTime } from '@/lib/booking';
import { toDisplayError } from '@/lib/errors';
import { useApi } from '@/providers/AppProviders';
import flow from '../../flow.module.css';

/**
 * Salt okunur değerlendirmeler. Herkese açık sağlayıcı profili ucu yok (faz-15-plan §3);
 * bu sayfa bilinçli olarak yalnızca puan ve yorumları gösterir.
 */
export function ProviderReviews({ userId }: { userId: string }) {
  return (
    <AppShell title="Değerlendirmeler">
      <Reviews userId={userId} />
    </AppShell>
  );
}

function Reviews({ userId }: { userId: string }) {
  const api = useApi();
  const reviews = useQuery({
    queryKey: ['users', userId, 'reviews'],
    queryFn: () => bookingsApi(api).reviewsFor(userId),
  });

  if (reviews.isPending) return <Skeleton lines={4} label="Değerlendirmeler yükleniyor" />;
  if (reviews.isError) {
    return <ErrorState {...toDisplayError(reviews.error)} onRetry={() => void reviews.refetch()} />;
  }
  if (reviews.data.length === 0) {
    return <EmptyState title="Henüz değerlendirme yok" />;
  }

  const average = reviews.data.reduce((sum, r) => sum + r.rating, 0) / reviews.data.length;
  return (
    <div className={flow.stack}>
      <Card tone="muted">
        <Overline>Ortalama</Overline>
        <p style={{ fontSize: '1.5rem' }}>
          {average.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} / 5
          <span className={flow.small}> · {reviews.data.length} değerlendirme</span>
        </p>
      </Card>
      <ul className={flow.list}>
        {reviews.data.map((review) => (
          <li key={review.id}>
            <Card as="article">
              <div className={flow.between}>
                <span aria-label={`${review.rating} yıldız`}>
                  {'★'.repeat(review.rating)}
                  <span className={flow.muted}>{'★'.repeat(5 - review.rating)}</span>
                </span>
                <time className={flow.small} dateTime={review.createdAt}>
                  {formatDateTime(review.createdAt)}
                </time>
              </div>
              {review.comment ? (
                <p style={{ marginTop: 'var(--space-xs)' }}>{review.comment}</p>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
