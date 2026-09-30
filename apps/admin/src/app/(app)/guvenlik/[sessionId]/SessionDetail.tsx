'use client';

import type { EvaluationResult, OperatorSessionDetail, RiskLevel } from '@emek/api-client';
import { Badge, Button, Card, ErrorState, Skeleton, TextArea, TextField } from '@emek/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ActionPanel } from '@/components/ActionPanel';
import { AppShell } from '@/components/AppShell';
import { Facts, Id, SelectFilter } from '@/components/Filters';
import { StatusBadge } from '@/components/StatusBadge';
import styles from '@/components/admin.module.css';
import { toDisplayError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { RISK_LEVELS, riskView } from '@/lib/labels';
import { useAdminApi, useStaff } from '@/providers/AppProviders';

export function SessionDetail({ sessionId }: { sessionId: string }) {
  const api = useAdminApi();
  const query = useQuery({
    queryKey: ['safety', 'session', sessionId],
    queryFn: () => api.safety.session(sessionId),
    refetchInterval: 30_000,
  });

  return (
    <AppShell title="Güvenlik oturumu">
      <p>
        <Link href="/guvenlik">← Güvenlik</Link>
      </p>
      {query.isPending ? (
        <Skeleton lines={6} />
      ) : query.isError ? (
        <ErrorState {...toDisplayError(query.error)} onRetry={() => void query.refetch()} />
      ) : (
        <SessionBody session={query.data} />
      )}
    </AppShell>
  );
}

function SessionBody({ session }: { session: OperatorSessionDetail }) {
  const api = useAdminApi();
  const { canWrite } = useStaff();
  const id = session.sessionId;
  const open = session.closedAt === null;
  const invalidate = [['safety']];
  // Operatör seçim yapana kadar başlangıç değeri 30 sn'lik tazelemeyle gelen güncel düzeydir.
  const [pickedRisk, setRiskLevel] = useState<RiskLevel | null>(null);
  const riskLevel = pickedRisk ?? session.riskLevel;
  const [floor, setFloor] = useState('120');
  const floorMinutes = Number(floor);
  const floorValid = Number.isInteger(floorMinutes) && floorMinutes >= 5 && floorMinutes <= 1440;
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);

  return (
    <div className={styles.stack}>
      <Card>
        <div className={styles.between}>
          <p>
            Oturum <Id value={id} /> · randevu <Id value={session.bookingId} />
          </p>
          <div className={styles.row}>
            {session.emergencyActive ? <Badge tone="danger">Panik etkin</Badge> : null}
            {session.anomalyFlagged ? <Badge tone="highlight">Anomali</Badge> : null}
            <StatusBadge view={riskView} code={session.riskLevel} />
          </div>
        </div>
        <Facts
          items={[
            ['Durum', session.status],
            ['Geofence', session.geofenceState],
            [
              'Son mesafe',
              session.lastDistanceMeters === null
                ? '—'
                : `${Math.round(session.lastDistanceMeters)} m`,
            ],
            ['Son telemetri', formatDateTime(session.lastTelemetryAt)],
            ['Telemetri / ret', `${session.telemetryCount} / ${session.rejectedCount}`],
            ['Bütünlük reddi', session.integrityRejectionCount],
            ['Sahte konum sinyali', session.mockLocationCount],
            ['Panik', formatDateTime(session.panicRaisedAt)],
            ['Sağlayıcı', <Id key="p" value={session.providerId} />],
            ['Müşteri', <Id key="c" value={session.customerId} />],
            ['Plan başlangıç', formatDateTime(session.scheduledStart)],
            ['Plan bitiş', formatDateTime(session.scheduledEnd)],
            [
              'Kapanış',
              session.closedAt
                ? `${formatDateTime(session.closedAt)} — ${session.closureReason ?? ''}`
                : '—',
            ],
            ['Konum saklama sonu', formatDateTime(session.retentionExpiresAt)],
            ['Konum silindi', formatDateTime(session.locationPurgedAt)],
            ['Etkin kurallar', session.activeRules.join(', ') || '—'],
          ]}
        />
        {open ? (
          <div className={styles.row}>
            <ActionPanel
              trigger="Şimdi değerlendir"
              title="Anında risk değerlendirmesi"
              description="Kurallar ve anomali modeli izleyiciyi beklemeden çalışır; sonuç kayda geçer."
              confirmLabel="Değerlendir"
              run={() => api.safety.evaluate(id)}
              invalidate={invalidate}
              onDone={setEvaluation}
            />
            <ActionPanel
              trigger="Risk düzeyini değiştir"
              variant="primary"
              title="Operatör risk kararı"
              description="Karar, belirtilen süre boyunca otomatik değerlendirmenin inemeyeceği bir taban olur. Acil durumdan inmek etkin paniği çözer."
              confirmLabel="Kararı uygula"
              reason={{ label: 'Gerekçe', required: true, minLength: 5, maxLength: 500 }}
              extra={
                <>
                  <SelectFilter
                    label="Yeni risk düzeyi"
                    value={riskLevel}
                    options={RISK_LEVELS.map((level) => ({
                      value: level,
                      label: riskView(level).label,
                    }))}
                    onChange={(value) => setRiskLevel(value as RiskLevel)}
                  />
                  {riskLevel !== 'NORMAL' ? (
                    <TextField
                      label="Taban süresi (dakika)"
                      inputMode="numeric"
                      value={floor}
                      onChange={(event) => setFloor(event.target.value)}
                      error={floorValid ? undefined : '5 ile 1440 arasında bir sayı girin.'}
                    />
                  ) : null}
                </>
              }
              extraValid={riskLevel === 'NORMAL' || floorValid}
              payloadSignature={`${riskLevel}|${floor}`}
              run={({ reason, idempotencyKey }) =>
                api.safety.overrideRisk(
                  id,
                  {
                    riskLevel,
                    reason: reason ?? '',
                    ...(riskLevel !== 'NORMAL' ? { floorMinutes } : {}),
                  },
                  idempotencyKey,
                )
              }
              invalidate={invalidate}
            />
            <ActionPanel
              trigger="Oturumu kapat"
              variant="danger"
              title="Oturumu kapat"
              description="İzleme sona erer. Gerekçesiz kapanış alarmı sessizce kapatabileceği için gerekçe zorunludur."
              confirmLabel="Kapat"
              acknowledge="Taraflarla iletişim kurdum ve güvenlik riski kalmadığını doğruladım."
              reason={{ label: 'Kapanış gerekçesi', required: true, minLength: 5, maxLength: 500 }}
              run={({ reason, idempotencyKey }) =>
                api.safety.close(id, reason ?? '', idempotencyKey)
              }
              invalidate={invalidate}
            />
          </div>
        ) : null}
        {evaluation ? <EvaluationSummary result={evaluation} /> : null}
      </Card>

      {canWrite ? <RawLocations session={session} /> : null}

      <Card>
        <h2>Değerlendirmeler</h2>
        {session.assessments.length === 0 ? (
          <p className={styles.muted}>Henüz değerlendirme yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Zaman</th>
                  <th>Önceki</th>
                  <th>Hesaplanan</th>
                  <th>Sonuç</th>
                  <th>Karar veren</th>
                  <th>Kural seti</th>
                  <th>Anomali</th>
                  <th>Eksik sinyal</th>
                </tr>
              </thead>
              <tbody>
                {session.assessments.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.evaluatedAt)}</td>
                    <td>{row.previousRiskLevel}</td>
                    <td>{row.computedRiskLevel}</td>
                    <td>{row.riskLevel}</td>
                    <td>{row.determinedBy}</td>
                    <td>{row.rulesetVersion}</td>
                    <td>
                      {row.anomalyAvailable && row.anomalyScore !== null
                        ? `${row.anomalyScore.toFixed(2)} (${row.anomalyModelVersion ?? '?'})`
                        : 'yok'}
                    </td>
                    <td>{row.unavailableSignals.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2>Olaylar</h2>
        {session.events.length === 0 ? (
          <p className={styles.muted}>Olay yok.</p>
        ) : (
          <ul className={styles.list}>
            {session.events.map((event) => (
              <li key={event.id}>
                <div className={styles.between}>
                  <p>
                    <strong>{event.eventType}</strong>{' '}
                    <span className={styles.small}>
                      {formatDateTime(event.occurredAt)} · {event.source}
                      {event.ruleId ? ` · ${event.ruleId}@${event.ruleVersion ?? '?'}` : ''}
                    </span>
                  </p>
                  <StatusBadge view={riskView} code={event.riskLevel} />
                </div>
                {Object.keys(event.details).length > 0 ? (
                  <pre className={styles.pre}>{JSON.stringify(event.details, null, 2)}</pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function EvaluationSummary({ result }: { result: EvaluationResult }) {
  return (
    <div className={styles.notice} role="status">
      Değerlendirme: {result.status} · {result.previousRiskLevel ?? '—'} → {result.riskLevel ?? '—'}{' '}
      (hesaplanan {result.computedRiskLevel ?? '—'}) · {result.findings.length} bulgu · anomali{' '}
      {result.anomaly.status}
      {result.unavailableSignals.length > 0
        ? ` · eksik sinyal: ${result.unavailableSignals.join(', ')}`
        : ''}{' '}
      · {result.latencyMs} ms
    </div>
  );
}

/**
 * Ham konum izi: yalnız ADMIN, amaç beyanı zorunlu, her okuma audit'li (ADR-0013 §4, amaçla
 * sınırlılık). Sonuç TanStack önbelleğine **yazılmaz** (mutation durumu) ve ekrandan kalkınca
 * bellekten düşer; tarayıcı depolamasına hiçbir koşulda yazılmaz.
 */
function RawLocations({ session }: { session: OperatorSessionDetail }) {
  const api = useAdminApi();
  const [reason, setReason] = useState('');
  const [breakGlass, setBreakGlass] = useState(false);
  const trimmed = reason.trim();
  const needsBreakGlass = session.riskLevel === 'NORMAL' && session.panicRaisedAt === null;
  const read = useMutation({
    mutationFn: () => api.safety.locations(session.sessionId, { reason: trimmed, breakGlass }),
    gcTime: 0,
  });

  if (read.isSuccess) {
    const { locations, locationPurgedAt } = read.data;
    return (
      <Card>
        <div className={styles.between}>
          <h2>Ham konum izi ({locations.length} nokta)</h2>
          <Button variant="secondary" onClick={() => read.reset()}>
            Gizle
          </Button>
        </div>
        {locationPurgedAt ? (
          <p className={styles.notice}>
            Konum verisi saklama süresi dolduğu için {formatDateTime(locationPurgedAt)} tarihinde
            silindi.
          </p>
        ) : null}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Sıra</th>
                <th>Cihaz zamanı</th>
                <th>Sunucu zamanı</th>
                <th>Enlem</th>
                <th>Boylam</th>
                <th>Doğruluk</th>
                <th>Mesafe</th>
                <th>Geofence</th>
                <th>Sahte konum</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((point) => (
                <tr key={point.sequence}>
                  <td>{point.sequence}</td>
                  <td>{formatDateTime(point.capturedAt)}</td>
                  <td>{formatDateTime(point.receivedAt)}</td>
                  <td>{point.latitude.toFixed(5)}</td>
                  <td>{point.longitude.toFixed(5)}</td>
                  <td>{Math.round(point.accuracyMeters)} m</td>
                  <td>{Math.round(point.distanceMeters)} m</td>
                  <td>{point.geofenceState}</td>
                  <td>{point.isMockLocation ? 'EVET' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h2>Ham konum izi</h2>
      <p className={styles.small}>
        Koordinatlar kişisel veridir. Okuma amacınızla birlikte kayda geçer ve denetlenir.
      </p>
      <div className={styles.panel}>
        <TextArea
          label="Erişim amacı"
          hint="En az 5 karakter; denetim kaydına yazılır."
          value={reason}
          maxLength={500}
          rows={2}
          onChange={(event) => setReason(event.target.value)}
        />
        {needsBreakGlass ? (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={breakGlass}
              onChange={(event) => setBreakGlass(event.target.checked)}
            />
            <span>
              Risk normal ve panik yok: bu okuma “cam kırma” olarak ayrıca işaretlenecek. Gerekçemin
              bunu haklı kıldığını beyan ederim.
            </span>
          </label>
        ) : null}
        {read.isError ? (
          <p role="alert" className={styles.small}>
            {toDisplayError(read.error).message}
          </p>
        ) : null}
        <div className={styles.row}>
          <Button
            variant="secondary"
            disabled={trimmed.length < 5 || (needsBreakGlass && !breakGlass)}
            loading={read.isPending}
            onClick={() => read.mutate()}
          >
            Konum izini göster
          </Button>
        </div>
      </div>
    </Card>
  );
}
