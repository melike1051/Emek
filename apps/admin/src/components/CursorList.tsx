'use client';

import type { Page } from '@emek/api-client';
import { Button, EmptyState, ErrorState, Skeleton } from '@emek/ui';
import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { toDisplayError } from '@/lib/errors';
import styles from './admin.module.css';

/** Keyset sayfalı admin listesi (`{ items, nextCursor }`); cursor opaktır, yorumlanmaz. */
export function useCursorList<T>(
  queryKey: QueryKey,
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
) {
  return useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function CursorList<T>({
  query,
  itemKey,
  renderItem,
  emptyTitle,
  emptyDescription,
}: {
  query: ReturnType<typeof useCursorList<T>>;
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  emptyTitle: string;
  emptyDescription?: string;
}) {
  if (query.isPending) return <Skeleton lines={4} />;
  // Sonraki sayfa hatası da `isError` yapar; o durumda yüklenmiş sayfalar ekranda kalır.
  if (query.data === undefined) {
    return <ErrorState {...toDisplayError(query.error)} onRetry={() => void query.refetch()} />;
  }
  const items = query.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <div className={styles.stack}>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={itemKey(item)}>{renderItem(item)}</li>
        ))}
      </ul>
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Daha fazla yükle
        </Button>
      ) : null}
      {query.isFetchNextPageError ? (
        <ErrorState {...toDisplayError(query.error)} onRetry={() => void query.fetchNextPage()} />
      ) : null}
    </div>
  );
}
