import { EmptyState } from '@emek/ui';
import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      style={{
        padding: 'var(--space-2xl) var(--page-margin)',
        maxWidth: '40rem',
        margin: '0 auto',
      }}
    >
      <EmptyState
        title="Sayfa bulunamadı"
        description="Aradığınız sayfa taşınmış ya da hiç var olmamış olabilir."
        action={<Link href="/">Ana sayfaya dön</Link>}
      />
    </main>
  );
}
