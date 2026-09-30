'use client';

import type { ProviderProfile, ProviderState } from '@emek/api-client';
import { Card } from '@emek/ui';
import { useState } from 'react';
import { ActionPanel } from '@/components/ActionPanel';
import { AppShell } from '@/components/AppShell';
import { CursorList, useCursorList } from '@/components/CursorList';
import { Facts, FilterBar, Id, SelectFilter } from '@/components/Filters';
import { StatusBadge } from '@/components/StatusBadge';
import styles from '@/components/admin.module.css';
import { formatDateTime } from '@/lib/format';
import { providerStateView } from '@/lib/labels';
import { useAdminApi } from '@/providers/AppProviders';

const STATES: ProviderState[] = ['PENDING_REVIEW', 'APPROVED', 'SUSPENDED', 'REJECTED', 'DRAFT'];
const REASON = { required: true, minLength: 3, maxLength: 500 } as const;

export function ProvidersScreen() {
  const api = useAdminApi();
  const [state, setState] = useState<ProviderState>('PENDING_REVIEW');
  const query = useCursorList(['providers', state], (cursor) =>
    api.providers.queue({ state, cursor }),
  );

  return (
    <AppShell title="Sağlayıcılar">
      <div className={styles.stack}>
        <FilterBar>
          <SelectFilter
            label="Durum"
            value={state}
            options={STATES.map((value) => ({ value, label: providerStateView(value).label }))}
            onChange={(value) => setState(value as ProviderState)}
          />
        </FilterBar>
        <p className={styles.notice}>
          Kuyruk yalnızca başvuru profilini gösterir. Beceri doğrulaması, hizmet bölgesi ve kimlik
          durumu için henüz operatör ucu yoktur (R-105).
        </p>
        <CursorList
          query={query}
          itemKey={(provider) => provider.userId}
          emptyTitle="Bu durumda sağlayıcı yok"
          renderItem={(provider) => <ProviderCard provider={provider} />}
        />
      </div>
    </AppShell>
  );
}

function ProviderCard({ provider }: { provider: ProviderProfile }) {
  const api = useAdminApi();
  const invalidate = [['providers']];
  const id = provider.userId;

  return (
    <Card>
      <div className={styles.between}>
        <div>
          <h2>{provider.displayName}</h2>
          <p className={styles.small}>
            Kullanıcı <Id value={id} /> · başvuru {formatDateTime(provider.createdAt)}
          </p>
        </div>
        <StatusBadge view={providerStateView} code={provider.state} />
      </div>
      {provider.bio ? <p>{provider.bio}</p> : null}
      <Facts
        items={[
          ['Deneyim', provider.experienceYears === null ? '—' : `${provider.experienceYears} yıl`],
          [
            'Puan',
            provider.ratingAvg === null
              ? 'henüz yok'
              : `${provider.ratingAvg.toFixed(1)} (${provider.ratingCount})`,
          ],
          ['Günlük azami iş', provider.maxDailyBookings],
          ['Son güncelleme', formatDateTime(provider.updatedAt)],
        ]}
      />
      <div className={styles.row}>
        {provider.state === 'PENDING_REVIEW' ? (
          <>
            <ActionPanel
              trigger="Onayla"
              variant="primary"
              title="Başvuruyu onayla"
              description="Sağlayıcı eşleştirmede görünür hâle gelir."
              confirmLabel="Onayla"
              run={({ idempotencyKey }) => api.providers.approve(id, idempotencyKey)}
              invalidate={invalidate}
            />
            <ActionPanel
              trigger="Reddet"
              variant="danger"
              title="Başvuruyu reddet"
              description="Sağlayıcı profilini düzeltip yeniden başvurabilir."
              confirmLabel="Reddet"
              reason={{ ...REASON, label: 'Ret gerekçesi' }}
              run={({ reason, idempotencyKey }) =>
                api.providers.reject(id, reason ?? '', idempotencyKey)
              }
              invalidate={invalidate}
            />
          </>
        ) : null}
        {provider.state === 'APPROVED' ? (
          <ActionPanel
            trigger="Askıya al"
            variant="danger"
            title="Sağlayıcıyı askıya al"
            description="Sağlayıcı yeni eşleştirmelerden hemen düşer. Mevcut randevuları otomatik iptal edilmez; gerekiyorsa ayrıca ele alın."
            confirmLabel="Askıya al"
            reason={{ ...REASON, label: 'Askı gerekçesi' }}
            run={({ reason, idempotencyKey }) =>
              api.providers.suspend(id, reason ?? '', idempotencyKey)
            }
            invalidate={invalidate}
          />
        ) : null}
        {provider.state === 'SUSPENDED' ? (
          <ActionPanel
            trigger="Askıyı kaldır"
            title="Sağlayıcıyı yeniden etkinleştir"
            confirmLabel="Askıyı kaldır"
            run={({ idempotencyKey }) => api.providers.reinstate(id, idempotencyKey)}
            invalidate={invalidate}
          />
        ) : null}
      </div>
    </Card>
  );
}
