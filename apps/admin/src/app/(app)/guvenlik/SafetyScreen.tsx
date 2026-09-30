'use client';

import type { RiskLevel, SafetyEventType } from '@emek/api-client';
import { Badge, Card, EmptyState, ErrorState, Skeleton } from '@emek/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { CursorList, useCursorList } from '@/components/CursorList';
import { Facts, FilterBar, Id, SelectFilter } from '@/components/Filters';
import { StatusBadge } from '@/components/StatusBadge';
import styles from '@/components/admin.module.css';
import { toDisplayError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { RISK_LEVELS, SAFETY_EVENT_TYPES, riskView } from '@/lib/labels';
import { useAdminApi } from '@/providers/AppProviders';

type Tab = 'sessions' | 'events';

export function SafetyScreen() {
  const [tab, setTab] = useState<Tab>('sessions');
  return (
    <AppShell title="Güvenlik">
      <div className={styles.stack}>
        <div role="tablist" className={styles.tabs} aria-label="Güvenlik görünümü">
          <button
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={tab === 'sessions'}
            onClick={() => setTab('sessions')}
          >
            Açık oturumlar
          </button>
          <button
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={tab === 'events'}
            onClick={() => setTab('events')}
          >
            Olay akışı
          </button>
        </div>
        {tab === 'sessions' ? <OpenSessions /> : <EventFeed />}
      </div>
    </AppShell>
  );
}

const riskOptions = RISK_LEVELS.map((value) => ({
  value,
  label: `${riskView(value).label} ve üstü`,
}));

function OpenSessions() {
  const api = useAdminApi();
  const [minRisk, setMinRisk] = useState<RiskLevel>('NORMAL');
  const query = useQuery({
    queryKey: ['safety', 'sessions', minRisk],
    queryFn: () => api.safety.sessions(minRisk),
    // Açık oturum listesi canlı triyajdır; ekran açıkken tazelenir.
    refetchInterval: 30_000,
  });

  return (
    <div className={styles.stack}>
      <FilterBar>
        <SelectFilter
          label="Asgari risk"
          value={minRisk}
          options={riskOptions}
          onChange={(value) => setMinRisk(value as RiskLevel)}
        />
      </FilterBar>
      {query.isPending ? (
        <Skeleton lines={4} />
      ) : query.isError ? (
        <ErrorState {...toDisplayError(query.error)} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <EmptyState
          title="Açık oturum yok"
          description="Bu risk düzeyinde izlenen oturum bulunmuyor."
        />
      ) : (
        <ul className={styles.list}>
          {query.data.map((session) => (
            <li key={session.sessionId}>
              <Card>
                <div className={styles.between}>
                  <Link href={`/guvenlik/${encodeURIComponent(session.sessionId)}`}>
                    Oturum <Id value={session.sessionId} />
                  </Link>
                  <div className={styles.row}>
                    {session.emergencyActive ? <Badge tone="danger">Panik etkin</Badge> : null}
                    {session.anomalyFlagged ? <Badge tone="highlight">Anomali</Badge> : null}
                    <StatusBadge view={riskView} code={session.riskLevel} />
                  </div>
                </div>
                <Facts
                  items={[
                    ['Randevu', <Id key="b" value={session.bookingId} />],
                    ['Durum', session.status],
                    ['Geofence', session.geofenceState],
                    ['Son telemetri', formatDateTime(session.lastTelemetryAt)],
                    [
                      'Plan',
                      `${formatDateTime(session.scheduledStart)} – ${formatDateTime(session.scheduledEnd)}`,
                    ],
                    ['Etkin kurallar', session.activeRules.join(', ') || '—'],
                  ]}
                />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventFeed() {
  const api = useAdminApi();
  const [minRisk, setMinRisk] = useState('');
  const [type, setType] = useState('');
  const filters = {
    minRisk: (minRisk || undefined) as RiskLevel | undefined,
    type: (type || undefined) as SafetyEventType | undefined,
  };
  const query = useCursorList(['safety', 'events', filters], (cursor) =>
    api.safety.events({ ...filters, cursor }),
  );

  return (
    <div className={styles.stack}>
      <FilterBar>
        <SelectFilter
          label="Asgari risk"
          value={minRisk}
          allLabel="Tümü"
          options={riskOptions}
          onChange={setMinRisk}
        />
        <SelectFilter
          label="Olay türü"
          value={type}
          allLabel="Tümü"
          options={SAFETY_EVENT_TYPES.map((value) => ({ value, label: value }))}
          onChange={setType}
        />
      </FilterBar>
      <CursorList
        query={query}
        itemKey={(event) => event.id}
        emptyTitle="Olay yok"
        renderItem={(event) => (
          <Card>
            <div className={styles.between}>
              <p>
                <strong>{event.eventType}</strong>{' '}
                <span className={styles.small}>
                  {formatDateTime(event.occurredAt)} · {event.source}
                </span>
              </p>
              <StatusBadge view={riskView} code={event.riskLevel} />
            </div>
            <p className={styles.small}>
              <Link href={`/guvenlik/${encodeURIComponent(event.sessionId)}`}>
                Oturum <Id value={event.sessionId} />
              </Link>{' '}
              · randevu <Id value={event.bookingId} />
              {event.ruleId ? ` · kural ${event.ruleId}@${event.ruleVersion ?? '?'}` : ''}
              {event.anomalyScore !== null ? ` · anomali ${event.anomalyScore.toFixed(2)}` : ''}
            </p>
          </Card>
        )}
      />
    </div>
  );
}
