'use client';

import type {
  AuditChainStatus,
  NotificationJobStatus,
  RetentionSweepResult,
} from '@emek/api-client';
import { Badge, Card, ErrorState, Skeleton } from '@emek/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ActionPanel } from '@/components/ActionPanel';
import { AppShell } from '@/components/AppShell';
import { CursorList, useCursorList } from '@/components/CursorList';
import { Facts, FilterBar, Id, SelectFilter } from '@/components/Filters';
import styles from '@/components/admin.module.css';
import { toDisplayError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useAdminApi } from '@/providers/AppProviders';

type Tab = 'dlq' | 'notifications' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dlq', label: 'Dead-letter kuyruğu' },
  { id: 'notifications', label: 'Bildirim işleri' },
  { id: 'audit', label: 'Denetim ve saklama' },
];

export function OpsScreen() {
  const [tab, setTab] = useState<Tab>('dlq');
  return (
    <AppShell title="Operasyon">
      <div className={styles.stack}>
        <div role="tablist" className={styles.tabs} aria-label="Operasyon görünümü">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className={styles.tab}
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {tab === 'dlq' ? (
          <DeadLetters />
        ) : tab === 'notifications' ? (
          <NotificationJobs />
        ) : (
          <AuditAndRetention />
        )}
      </div>
    </AppShell>
  );
}

function DeadLetters() {
  const api = useAdminApi();
  const [resolved, setResolved] = useState('false');
  const filter = resolved === '' ? undefined : resolved === 'true';
  const query = useCursorList(['ops', 'dlq', filter], (cursor) =>
    api.ops.deadLetters({ resolved: filter, cursor }),
  );

  return (
    <div className={styles.stack}>
      <FilterBar>
        <SelectFilter
          label="Durum"
          value={resolved}
          allLabel="Tümü"
          options={[
            { value: 'false', label: 'Çözülmemiş' },
            { value: 'true', label: 'Çözülmüş' },
          ]}
          onChange={setResolved}
        />
      </FilterBar>
      <CursorList
        query={query}
        itemKey={(row) => row.id}
        emptyTitle="Dead-letter kaydı yok"
        renderItem={(row) => (
          <Card>
            <div className={styles.between}>
              <p>
                <strong>{row.eventType}</strong> v{row.eventVersion} →{' '}
                <span className={styles.code}>{row.consumer}</span>
              </p>
              {row.resolvedAt ? (
                <Badge tone="neutral">Çözüldü</Badge>
              ) : (
                <Badge tone="danger">{row.failureClassification}</Badge>
              )}
            </div>
            <Facts
              items={[
                ['Kayıt', row.id],
                ['Olay', <Id key="e" value={row.eventId} />],
                ['Deneme', row.attemptCount],
                ['İlk hata', formatDateTime(row.firstFailureAt)],
                ['Son hata', formatDateTime(row.lastFailureAt)],
                ['Çözülme', formatDateTime(row.resolvedAt)],
              ]}
            />
            <p className={styles.small}>Hata: {row.failureReason}</p>
            <details>
              <summary className={styles.small}>Payload (yalnız kimlik referansları)</summary>
              <pre className={styles.pre}>{JSON.stringify(row.payload, null, 2)}</pre>
            </details>
            {row.resolvedAt === null ? (
              <ActionPanel
                trigger="Çözüldü işaretle"
                title="Kaydı çözüldü olarak kapat"
                description="Olay yeniden işlenmez; yalnızca kayıt kapatılır. Gerekiyorsa etkisini önce elle giderin."
                confirmLabel="Kapat"
                run={({ idempotencyKey }) => api.ops.resolveDeadLetter(row.id, idempotencyKey)}
                invalidate={[['ops']]}
              />
            ) : null}
          </Card>
        )}
      />
    </div>
  );
}

const JOB_STATUSES: NotificationJobStatus[] = ['FAILED', 'PENDING', 'SENT'];

function NotificationJobs() {
  const api = useAdminApi();
  const [status, setStatus] = useState('FAILED');
  const filter = (status || undefined) as NotificationJobStatus | undefined;
  const query = useCursorList(['ops', 'notifications', filter], (cursor) =>
    api.ops.notificationJobs({ status: filter, cursor }),
  );

  return (
    <div className={styles.stack}>
      <FilterBar>
        <SelectFilter
          label="Durum"
          value={status}
          allLabel="Tümü"
          options={JOB_STATUSES.map((value) => ({ value, label: value }))}
          onChange={setStatus}
        />
      </FilterBar>
      <CursorList
        query={query}
        itemKey={(job) => job.id}
        emptyTitle="Bildirim işi yok"
        renderItem={(job) => (
          <Card>
            <div className={styles.between}>
              <p>
                <strong>{job.templateKey}</strong> · {job.channel}
              </p>
              <Badge
                tone={
                  job.status === 'FAILED' ? 'danger' : job.status === 'SENT' ? 'trust' : 'highlight'
                }
              >
                {job.status}
              </Badge>
            </div>
            <Facts
              items={[
                ['İş', job.id],
                ['Olay', `${job.eventType}`],
                ['Alıcı', <Id key="r" value={job.recipientUserId} />],
                ['Deneme', job.attempts],
                ['Oluşturulma', formatDateTime(job.createdAt)],
                ['Gönderim', formatDateTime(job.sentAt)],
              ]}
            />
            {job.lastError ? <p className={styles.small}>Son hata: {job.lastError}</p> : null}
            {job.status === 'FAILED' ? (
              <ActionPanel
                trigger="Yeniden kuyrukla"
                title="Bildirimi yeniden dene"
                description="İş tekrar gönderim kuyruğuna alınır; alıcı bildirimi bir kez daha alabilir."
                confirmLabel="Yeniden dene"
                run={({ idempotencyKey }) => api.ops.retryNotificationJob(job.id, idempotencyKey)}
                invalidate={[['ops']]}
              />
            ) : null}
          </Card>
        )}
      />
    </div>
  );
}

function AuditAndRetention() {
  const api = useAdminApi();
  const chain = useQuery({ queryKey: ['ops', 'audit-chain'], queryFn: api.ops.auditChain });
  const [sweep, setSweep] = useState<RetentionSweepResult | null>(null);
  // Durum ucu yalnız son kontrol noktasını döner (`rowsVerified` orada hep 0); turda
  // doğrulanan satır sayısı yalnızca doğrulama yanıtındadır.
  const [verified, setVerified] = useState<AuditChainStatus | null>(null);

  return (
    <div className={styles.grid}>
      <Card>
        <h2>Denetim zinciri</h2>
        {chain.isPending ? (
          <Skeleton lines={2} />
        ) : chain.isError ? (
          <ErrorState {...toDisplayError(chain.error)} onRetry={() => void chain.refetch()} />
        ) : (
          <div className={styles.stack}>
            <p>
              {chain.data.status === 'OK' ? (
                <Badge tone="trust">Sağlam</Badge>
              ) : (
                <Badge tone="danger">Kopukluk bulundu</Badge>
              )}
            </p>
            <Facts
              items={[
                ['Doğrulanan son kayıt', chain.data.verifiedThroughId ?? 'henüz doğrulanmadı'],
                ['Kopukluk', chain.data.brokenAtId ?? '—'],
              ]}
            />
            {chain.data.status === 'BROKEN' ? (
              <p className={styles.notice}>
                Zincir kopukluğu bir güvenlik olayıdır: kayıtlar değiştirilmez, doğrulama bu
                noktadan ilerlemez. Olay müdahale sürecini başlatın.
              </p>
            ) : null}
          </div>
        )}
        <ActionPanel
          trigger="Şimdi doğrula"
          title="Zinciri doğrula"
          description="Son kontrol noktasından itibaren artımlı doğrulama yapılır ve yeni kontrol noktası yazılır. Denetim kayıtları değiştirilmez."
          confirmLabel="Doğrula"
          run={() => api.ops.verifyAuditChain()}
          invalidate={[['ops', 'audit-chain']]}
          onDone={setVerified}
        />
        {verified ? (
          <p className={styles.notice} role="status">
            Son doğrulama: {verified.rowsVerified} yeni kayıt doğrulandı —{' '}
            {verified.status === 'OK' ? 'zincir sağlam' : `kopukluk: ${verified.brokenAtId ?? '?'}`}
            .
          </p>
        ) : null}
      </Card>
      <Card>
        <h2>Saklama süresi taraması</h2>
        <p className={styles.small}>
          Saklama süresi dolan kayıtları siler veya anonimleştirir (data-retention-inventory).
          Zamanlanmış iş zaten çalışır; elle tetikleme olay müdahalesi içindir.
        </p>
        {sweep ? (
          <div role="status">
            <Facts
              items={[
                ['Anonimleştirilen kullanıcı', sweep.anonymizedUsers],
                ['İşlenmiş olay', sweep.processedEvents],
                ['Dead-letter', sweep.deadLetterEvents],
                ['Doğrulama denemesi', sweep.verificationAttempts],
                ['Analitik olay', sweep.analyticsEvents],
              ]}
            />
          </div>
        ) : null}
        <ActionPanel
          trigger="Taramayı çalıştır"
          variant="danger"
          title="Saklama taramasını şimdi çalıştır"
          description="Bu işlem veri siler ve geri alınamaz."
          confirmLabel="Çalıştır"
          acknowledge="Silinecek veri sınıflarını ve saklama sürelerini kontrol ettim."
          run={({ idempotencyKey }) => api.ops.retentionSweep(idempotencyKey)}
          invalidate={[['ops']]}
          onDone={setSweep}
        />
      </Card>
    </div>
  );
}
