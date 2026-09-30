'use client';

import type { DiscrepancyType, ReconciliationRun } from '@emek/api-client';
import { Badge, Card } from '@emek/ui';
import { useState } from 'react';
import { ActionPanel } from '@/components/ActionPanel';
import { AppShell } from '@/components/AppShell';
import { CursorList, useCursorList } from '@/components/CursorList';
import { Facts, FilterBar, Id, SelectFilter } from '@/components/Filters';
import styles from '@/components/admin.module.css';
import { formatDateTime } from '@/lib/format';
import { useAdminApi } from '@/providers/AppProviders';

const TYPES: { value: DiscrepancyType; label: string }[] = [
  { value: 'STUCK_PENDING_COMMAND', label: 'Takılı PSP komutu' },
  { value: 'AUTHORIZATION_EXPIRED_UNHANDLED', label: 'Ele alınmamış yetki sonu' },
  { value: 'RELEASE_PENDING_STALLED', label: 'Duran serbest bırakma' },
];
const typeLabel = (type: string) => TYPES.find((item) => item.value === type)?.label ?? type;

export function ReconciliationScreen() {
  const api = useAdminApi();
  const [resolved, setResolved] = useState('false');
  const [type, setType] = useState('');
  const [lastRun, setLastRun] = useState<ReconciliationRun | null>(null);
  const filters = {
    resolved: resolved === '' ? undefined : resolved === 'true',
    discrepancyType: (type || undefined) as DiscrepancyType | undefined,
  };
  const query = useCursorList(['analytics', 'reconciliation', filters], (cursor) =>
    api.analytics.discrepancies({ ...filters, cursor }),
  );

  return (
    <AppShell title="Mutabakat">
      <div className={styles.stack}>
        <p className={styles.small}>
          Ödeme kayıtlarının ödeme kuruluşu ile tutarsız kalabileceği durumlar. Bulguyu kapatmak
          para hareketi yapmaz; düzeltme Ödemeler ekranından yapılır.
        </p>
        <div className={styles.row}>
          <ActionPanel
            trigger="Mutabakatı şimdi çalıştır"
            title="Mutabakat turu"
            description="Tüm açık ödemeler kontrol edilir; yeni bulgular listeye eklenir."
            confirmLabel="Çalıştır"
            run={({ idempotencyKey }) => api.analytics.runReconciliation(idempotencyKey)}
            invalidate={[['analytics', 'reconciliation']]}
            onDone={setLastRun}
          />
        </div>
        {lastRun ? (
          <p className={styles.notice} role="status">
            Tur <Id value={lastRun.runId} />: {lastRun.checkedCount} ödeme kontrol edildi,{' '}
            {lastRun.discrepancyCount} bulgu ({lastRun.newDiscrepancyCount} yeni).
          </p>
        ) : null}
        <FilterBar>
          <SelectFilter
            label="Durum"
            value={resolved}
            allLabel="Tümü"
            options={[
              { value: 'false', label: 'Açık' },
              { value: 'true', label: 'Kapatılmış' },
            ]}
            onChange={setResolved}
          />
          <SelectFilter
            label="Tür"
            value={type}
            allLabel="Tümü"
            options={TYPES}
            onChange={setType}
          />
        </FilterBar>
        <CursorList
          query={query}
          itemKey={(row) => row.id}
          emptyTitle="Bulgu yok"
          renderItem={(row) => (
            <Card>
              <div className={styles.between}>
                <p>
                  <strong>{typeLabel(row.discrepancyType)}</strong>{' '}
                  <span className={styles.small}>({row.discrepancyType})</span>
                </p>
                {row.resolvedAt ? (
                  <Badge tone="neutral">Kapatıldı</Badge>
                ) : (
                  <Badge tone="danger">Açık</Badge>
                )}
              </div>
              <Facts
                items={[
                  ['Bulgu', row.id],
                  ['Ödeme', <Id key="p" value={row.paymentId} />],
                  ['Tur', <Id key="r" value={row.runId} />],
                  ['Tespit', formatDateTime(row.detectedAt)],
                  ['Kapanış', formatDateTime(row.resolvedAt)],
                  ['Kapatan', <Id key="b" value={row.resolvedBy} />],
                ]}
              />
              <details>
                <summary className={styles.small}>Ayrıntı</summary>
                <pre className={styles.pre}>{JSON.stringify(row.details, null, 2)}</pre>
              </details>
              {row.resolvedAt === null ? (
                <div className={styles.row}>
                  <ActionPanel
                    trigger="Kapat"
                    title="Bulguyu kapat"
                    description="Yalnızca kayıt kapatılır; ödeme durumu değişmez. Önce ödemenin gerçek durumunu doğrulayın."
                    confirmLabel="Kapat"
                    acknowledge="Ödemenin ödeme kuruluşundaki durumunu doğruladım."
                    run={({ idempotencyKey }) =>
                      api.analytics.resolveDiscrepancy(row.id, idempotencyKey)
                    }
                    invalidate={[['analytics', 'reconciliation']]}
                  />
                </div>
              ) : null}
            </Card>
          )}
        />
      </div>
    </AppShell>
  );
}
