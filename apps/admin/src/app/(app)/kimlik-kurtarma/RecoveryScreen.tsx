'use client';

import type { RecoveryRequest, RecoveryStatus } from '@emek/api-client';
import { Card } from '@emek/ui';
import { useState } from 'react';
import { ActionPanel } from '@/components/ActionPanel';
import { AppShell } from '@/components/AppShell';
import { CursorList, useCursorList } from '@/components/CursorList';
import { Facts, FilterBar, Id, SelectFilter } from '@/components/Filters';
import { StatusBadge } from '@/components/StatusBadge';
import styles from '@/components/admin.module.css';
import { formatDateTime } from '@/lib/format';
import { recoveryStatusView } from '@/lib/labels';
import { useAdminApi } from '@/providers/AppProviders';

const STATUSES: RecoveryStatus[] = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'];

export function RecoveryScreen() {
  const api = useAdminApi();
  const [status, setStatus] = useState<RecoveryStatus>('PENDING_REVIEW');
  const query = useCursorList(['recovery', status], (cursor) =>
    api.recovery.queue({ status, cursor }),
  );

  return (
    <AppShell title="Kimlik kurtarma">
      <div className={styles.stack}>
        <FilterBar>
          <SelectFilter
            label="Durum"
            value={status}
            options={STATUSES.map((value) => ({ value, label: recoveryStatusView(value).label }))}
            onChange={(value) => setStatus(value as RecoveryStatus)}
          />
        </FilterBar>
        <p className={styles.notice}>
          Onay, talep edenin giriş kimliğini hedef hesaba taşır (hesap devralma riski). Talebin
          tarafı olan operatör karar veremez; backend bu durumda işlemi reddeder (R-36).
        </p>
        <CursorList
          query={query}
          itemKey={(request) => request.id}
          emptyTitle="Bu durumda kurtarma talebi yok"
          renderItem={(request) => <RecoveryCard request={request} />}
        />
      </div>
    </AppShell>
  );
}

function RecoveryCard({ request }: { request: RecoveryRequest }) {
  const api = useAdminApi();
  const invalidate = [['recovery']];

  return (
    <Card>
      <div className={styles.between}>
        <p>
          Talep <Id value={request.id} />
        </p>
        <StatusBadge view={recoveryStatusView} code={request.status} />
      </div>
      <Facts
        items={[
          ['Talep eden (boş hesap)', <Id key="r" value={request.requesterUserId} />],
          ['Hedef hesap', <Id key="t" value={request.targetUserId} />],
          ['Güvence düzeyi', request.assuranceLevel],
          ['Oluşturulma', formatDateTime(request.createdAt)],
          ['Karar', formatDateTime(request.decidedAt)],
          ['Karar veren', <Id key="d" value={request.decidedBy} />],
        ]}
      />
      {request.decisionReason ? (
        <p className={styles.small}>Gerekçe: {request.decisionReason}</p>
      ) : null}
      {request.status === 'PENDING_REVIEW' ? (
        <div className={styles.row}>
          <ActionPanel
            trigger="Onayla"
            variant="primary"
            title="Kurtarmayı onayla"
            description="Talep edenin giriş kimliği hedef hesaba taşınır, talep eden boş hesap kapatılır. İşlem kayıt altına alınır ve kendiliğinden geri alınamaz."
            confirmLabel="Onayla"
            acknowledge="Talep edenin hedef hesabın sahibi olduğunu doğruladım."
            reason={{ label: 'Not', required: false, maxLength: 500 }}
            run={({ reason, idempotencyKey }) =>
              api.recovery.approve(request.id, reason, idempotencyKey)
            }
            invalidate={invalidate}
          />
          <ActionPanel
            trigger="Reddet"
            variant="danger"
            title="Kurtarmayı reddet"
            confirmLabel="Reddet"
            reason={{ label: 'Ret gerekçesi', required: true, maxLength: 500 }}
            run={({ reason, idempotencyKey }) =>
              api.recovery.reject(request.id, reason ?? '', idempotencyKey)
            }
            invalidate={invalidate}
          />
        </div>
      ) : null}
    </Card>
  );
}
