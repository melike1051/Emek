'use client';

import type {
  Dispute,
  DisputeReason,
  DisputeResolutionStatus,
  DisputeStatus,
} from '@emek/api-client';
import { Card, TextField } from '@emek/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ActionPanel } from '@/components/ActionPanel';
import { AppShell } from '@/components/AppShell';
import { CursorList, useCursorList } from '@/components/CursorList';
import { Facts, FilterBar, Id, SelectFilter } from '@/components/Filters';
import { StatusBadge } from '@/components/StatusBadge';
import styles from '@/components/admin.module.css';
import { formatDateTime, formatMoney, parseMoneyToMinor } from '@/lib/format';
import { DISPUTE_REASON_LABEL, disputeStatusView } from '@/lib/labels';
import { useAdminApi } from '@/providers/AppProviders';

const STATUSES: DisputeStatus[] = [
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED_CUSTOMER',
  'RESOLVED_PROVIDER',
  'WITHDRAWN',
];
const OPEN: ReadonlySet<string> = new Set(['OPEN', 'UNDER_REVIEW']);
const OUTCOMES: { value: DisputeResolutionStatus; label: string }[] = [
  { value: 'RESOLVED_CUSTOMER', label: 'Müşteri lehine' },
  { value: 'RESOLVED_PROVIDER', label: 'Sağlayıcı lehine' },
  { value: 'WITHDRAWN', label: 'Geri çekildi' },
];

export function DisputesScreen() {
  const api = useAdminApi();
  const [status, setStatus] = useState('OPEN');
  const filter = (status || undefined) as DisputeStatus | undefined;
  const query = useCursorList(['disputes', filter], (cursor) =>
    api.disputes.list({ status: filter, cursor }),
  );

  return (
    <AppShell title="İtirazlar">
      <div className={styles.stack}>
        <FilterBar>
          <SelectFilter
            label="Durum"
            value={status}
            allLabel="Tümü"
            options={STATUSES.map((value) => ({ value, label: disputeStatusView(value).label }))}
            onChange={setStatus}
          />
        </FilterBar>
        <CursorList
          query={query}
          itemKey={(dispute) => dispute.id}
          emptyTitle="Bu durumda itiraz yok"
          renderItem={(dispute) => <DisputeCard dispute={dispute} />}
        />
      </div>
    </AppShell>
  );
}

function DisputeCard({ dispute }: { dispute: Dispute }) {
  const api = useAdminApi();
  const [outcome, setOutcome] = useState<DisputeResolutionStatus>('RESOLVED_CUSTOMER');
  const [refund, setRefund] = useState('');
  const refundMinor = refund.trim() === '' ? undefined : parseMoneyToMinor(refund);

  return (
    <Card>
      <div className={styles.between}>
        <div>
          <h2>{DISPUTE_REASON_LABEL[dispute.reason as DisputeReason] ?? dispute.reason}</h2>
          <p className={styles.small}>
            İtiraz <Id value={dispute.id} /> · randevu <Id value={dispute.bookingId} /> ·{' '}
            {formatDateTime(dispute.createdAt)}
          </p>
        </div>
        <StatusBadge view={disputeStatusView} code={dispute.status} />
      </div>
      {dispute.description ? <p>{dispute.description}</p> : null}
      {dispute.resolution ? (
        <Facts
          items={[
            ['Karar', dispute.resolution],
            [
              'Karara bağlanan iade',
              // İtiraz kaydı para birimi taşımaz; pazaryeri tek para birimiyle (TRY) çalışır.
              dispute.refundAmountMinor ? formatMoney(dispute.refundAmountMinor, 'TRY') : '—',
            ],
            ['Karar tarihi', formatDateTime(dispute.resolvedAt)],
          ]}
        />
      ) : null}
      <div className={styles.row}>
        <Link href={`/odemeler?bookingId=${encodeURIComponent(dispute.bookingId)}`}>
          Randevunun ödemesi
        </Link>
        {OPEN.has(dispute.status) ? (
          <ActionPanel
            trigger="Karara bağla"
            variant="primary"
            title="İtirazı karara bağla"
            description="Karar yalnızca kaydedilir; iade tutarı yazılsa bile para hareketi Ödemeler ekranındaki ayrı “İade et” işlemiyle yapılır."
            confirmLabel="Kararı kaydet"
            acknowledge="Kanıtları ve iki tarafın beyanını inceledim."
            reason={{ label: 'Karar gerekçesi', required: true, maxLength: 2000 }}
            extra={
              <>
                <SelectFilter
                  label="Sonuç"
                  value={outcome}
                  options={OUTCOMES}
                  onChange={(value) => setOutcome(value as DisputeResolutionStatus)}
                />
                <TextField
                  label="Karara bağlanan iade (₺, isteğe bağlı)"
                  inputMode="decimal"
                  value={refund}
                  onChange={(event) => setRefund(event.target.value)}
                  error={refundMinor === null ? 'Geçerli bir tutar girin (ör. 150,00).' : undefined}
                />
              </>
            }
            extraValid={refundMinor !== null}
            payloadSignature={`${outcome}|${refundMinor ?? ''}`}
            run={({ reason, idempotencyKey }) =>
              api.disputes.resolve(
                dispute.id,
                {
                  status: outcome,
                  resolution: reason ?? '',
                  ...(refundMinor ? { refundAmountMinor: refundMinor } : {}),
                },
                idempotencyKey,
              )
            }
            invalidate={[['disputes'], ['payments'], ['bookings']]}
          />
        ) : null}
      </div>
    </Card>
  );
}
