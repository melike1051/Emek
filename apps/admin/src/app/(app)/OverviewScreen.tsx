'use client';

import { Badge, Card, ErrorState, Skeleton } from '@emek/ui';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { Facts } from '@/components/Filters';
import styles from '@/components/admin.module.css';
import { toDisplayError } from '@/lib/errors';
import { formatAge, formatDateTime } from '@/lib/format';
import { useAdminApi } from '@/providers/AppProviders';

/** Her kart kendi ucunu bağımsız okur: biri düşerse diğerleri görünmeye devam eder. */
function Tile<T>({
  title,
  query,
  link,
  children,
}: {
  title: string;
  query: UseQueryResult<T>;
  link?: { href: string; label: string };
  children: (data: T) => ReactNode;
}) {
  return (
    <Card>
      <div className={styles.between}>
        <h2>{title}</h2>
        {link ? <Link href={link.href}>{link.label}</Link> : null}
      </div>
      {query.isPending ? (
        <Skeleton lines={2} />
      ) : query.isError ? (
        <ErrorState {...toDisplayError(query.error)} onRetry={() => void query.refetch()} />
      ) : (
        children(query.data)
      )}
    </Card>
  );
}

export function OverviewScreen() {
  const api = useAdminApi();
  const health = useQuery({ queryKey: ['ops', 'health'], queryFn: api.ops.health });
  const chain = useQuery({ queryKey: ['ops', 'audit-chain'], queryFn: api.ops.auditChain });
  const exportStatus = useQuery({
    queryKey: ['analytics', 'export'],
    queryFn: api.analytics.exportStatus,
  });
  const matching = useQuery({
    queryKey: ['matching', 'stats', 7],
    queryFn: () => api.analytics.matchingStats(7),
  });

  return (
    <AppShell title="Genel bakış">
      <div className={styles.grid}>
        <Tile title="Olay kuyruğu" query={health} link={{ href: '/operasyon', label: 'Ayrıntı' }}>
          {(data) => (
            <Facts
              items={[
                ['Outbox bekleyen', data.outbox.pendingCount],
                ['Outbox başarısız', data.outbox.failedCount],
                ['En eski bekleyen', formatAge(data.outbox.oldestPendingAgeMs)],
                ['DLQ çözülmemiş', data.deadLetter.unresolvedCount],
                ...data.notificationJobs.map(
                  (row) => [`Bildirim ${row.status}`, row.count] as [string, ReactNode],
                ),
              ]}
            />
          )}
        </Tile>
        <Tile title="Denetim zinciri" query={chain} link={{ href: '/operasyon', label: 'Doğrula' }}>
          {(data) => (
            <div className={styles.stack}>
              <p>
                {data.status === 'OK' ? (
                  <Badge tone="trust">Sağlam</Badge>
                ) : (
                  <Badge tone="danger">Kopukluk bulundu</Badge>
                )}
              </p>
              <Facts
                items={[
                  ['Doğrulanan son kayıt', data.verifiedThroughId ?? 'henüz doğrulanmadı'],
                  ['Kopukluk', data.brokenAtId ?? '—'],
                ]}
              />
            </div>
          )}
        </Tile>
        <Tile title="Analitik aktarımı" query={exportStatus}>
          {(data) => (
            <Facts
              items={[
                ['Aktarılmamış olay', data.unexportedCount],
                ['En eski bekleyen', formatAge(data.oldestUnexportedAgeMs)],
                ['Son aktarım', formatDateTime(data.lastExportedAt)],
              ]}
            />
          )}
        </Tile>
        <Tile title="Eşleştirme (7 gün)" query={matching}>
          {(data) => (
            <Facts
              items={[
                ['Toplam koşu', data.totalRuns],
                [
                  'Yedek yola düşen',
                  `${data.degradedRuns} (%${(data.degradedRate * 100).toFixed(1)})`,
                ],
                ['Ort. aday', data.avgCandidateCount.toFixed(1)],
                ['Ort. karar süresi', `${Math.round(data.avgDecisionMs)} ms`],
                ...data.byDegradedReason.map(
                  (row) => [`Neden: ${row.reason}`, row.count] as [string, ReactNode],
                ),
              ]}
            />
          )}
        </Tile>
      </div>
    </AppShell>
  );
}
