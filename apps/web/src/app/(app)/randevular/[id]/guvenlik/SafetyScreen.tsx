'use client';

import { safetyApi, type PanicCategory } from '@emek/api-client';
import { Badge, Button, Card, EmptyState, ErrorState, Overline, Skeleton } from '@emek/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { formatDateTime } from '@/lib/booking';
import { toDisplayError } from '@/lib/errors';
import { useApi } from '@/providers/AppProviders';
import flow from '../../../flow.module.css';

const SESSION_STATUS: Record<string, string> = {
  NOT_STARTED: 'Hizmet saatinde başlayacak',
  PRE_SERVICE: 'Hizmet saatinde başlayacak',
  ACTIVE: 'Hizmet oturumu aktif',
  CLOSED: 'Oturum kapandı',
};

const CATEGORIES: { value: PanicCategory; label: string }[] = [
  { value: 'THREAT', label: 'Tehdit' },
  { value: 'HEALTH', label: 'Sağlık' },
  { value: 'OTHER', label: 'Diğer' },
];

/**
 * Taraf görünümü bilinçli olarak dardır (ADR-0019 §9): risk seviyesi/kurallar/konum gösterilmez.
 * Panik deterministik ve anlıktır: tek onay adımı, kategori **isteğe bağlı** (seçmek gönderimi
 * geciktirmez), otomatik yeniden deneme yok ama buton hata sonrası hemen tekrar basılabilir —
 * backend tekrar basışı tekilleştirir. Sağlayıcıdan konum telemetrisi web'den gönderilmez (Faz 16).
 */
export type SafetyPerspective = 'customer' | 'provider';

const PERSPECTIVE: Record<
  SafetyPerspective,
  { base: string; privacy: string; notStarted: string; arriving: string }
> = {
  customer: {
    base: '/randevular',
    privacy:
      'Konum yalnızca aktif hizmet süresince ve yalnızca sağlayıcıdan alınır; sizin konumunuz toplanmaz.',
    notStarted: 'Oturum, hizmet günü sağlayıcı yola çıktığında otomatik açılır.',
    arriving: 'Sağlayıcı yolda — varış izleniyor',
  },
  provider: {
    base: '/panel/randevular',
    // Telemetri web'den gönderilmez (plan §2.3): konum paylaşımı mobil uygulamadandır (Faz 16).
    privacy:
      'Konumunuz yalnızca bu hizmet süresince, mobil uygulamadan paylaşılır; web sitesi konum göndermez. Müşteri konumunuzu görmez.',
    notStarted: 'Oturum, randevu ekranında “Yola çıktım” dediğinizde otomatik açılır.',
    arriving: 'Yoldasınız — varışınız izleniyor',
  },
};

export function SafetyScreen({
  bookingId,
  perspective = 'customer',
}: {
  bookingId: string;
  perspective?: SafetyPerspective;
}) {
  return (
    <AppShell title="Güvenlik">
      <Session bookingId={bookingId} perspective={perspective} />
    </AppShell>
  );
}

function Session({
  bookingId,
  perspective,
}: {
  bookingId: string;
  perspective: SafetyPerspective;
}) {
  const view = PERSPECTIVE[perspective];
  const api = useApi();
  const queryClient = useQueryClient();
  const [armed, setArmed] = useState(false);
  const [category, setCategory] = useState<PanicCategory | undefined>(undefined);
  const key = ['bookings', bookingId, 'safety-session'];

  const session = useQuery({
    queryKey: key,
    queryFn: () => safetyApi(api).sessionForBooking(bookingId),
    refetchInterval: 30_000,
  });
  const panic = useMutation({
    mutationFn: (sessionId: string) => safetyApi(api).panic(sessionId, category),
    onSuccess: async () => {
      setArmed(false);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const back = <Link href={`${view.base}/${bookingId}`}>Randevuya dön</Link>;
  if (session.isPending) return <Skeleton lines={3} label="Oturum yükleniyor" />;
  if (session.isError) {
    return <ErrorState {...toDisplayError(session.error)} onRetry={() => void session.refetch()} />;
  }
  if (session.data === null) {
    return (
      <EmptyState
        title="Güvenlik oturumu henüz başlamadı"
        description={view.notStarted}
        action={back}
      />
    );
  }

  const data = session.data;
  const closed = data.status === 'CLOSED';
  const emergency = data.emergencyActive || panic.isSuccess;
  // Backend paniği yalnız varış ve aktif hizmette kabul eder (panic.service.ts assertAccepting):
  // PRE_SERVICE'te basılabilen bir buton, acil anda yalnızca hata gösterirdi.
  const accepting = data.status === 'ARRIVAL_MONITORING' || data.status === 'ACTIVE';

  return (
    <div className={flow.stack}>
      <Card>
        <div className={flow.between}>
          <Overline>Oturum</Overline>
          <Badge tone={closed ? 'neutral' : 'trust'}>
            {data.status === 'ARRIVAL_MONITORING'
              ? view.arriving
              : (SESSION_STATUS[data.status] ?? data.status)}
          </Badge>
        </div>
        <p className={flow.small} style={{ marginTop: 'var(--space-sm)' }}>
          {view.privacy}
        </p>
      </Card>

      {emergency ? (
        <Card>
          <div role="alert" className={flow.stack}>
            <span className={flow.alignStart}>
              <Badge tone="danger">Acil durum kaydınız alındı</Badge>
            </span>
            <p>
              Operasyon ekibimiz bilgilendirildi.
              {data.panicRaisedAt ? ` Kayıt: ${formatDateTime(data.panicRaisedAt)}.` : null}
            </p>
            <p>
              <strong>Hayati tehlike varsa hemen 112’yi arayın.</strong>
            </p>
            <a href="tel:112">112’yi ara</a>
          </div>
        </Card>
      ) : null}

      {!closed && !emergency && !accepting ? (
        <Card>
          <Overline>Acil durum</Overline>
          <p style={{ marginTop: 'var(--space-sm)' }}>
            Acil durum bildirimi hizmet başladığında buradan açılır. Şu an acil bir durum varsa
            hemen 112&apos;yi arayın.
          </p>
          <a href="tel:112">112’yi ara</a>
        </Card>
      ) : null}
      {!closed && !emergency && accepting ? (
        <Card>
          <Overline>Acil durum</Overline>
          {armed ? (
            <div className={flow.stack} style={{ marginTop: 'var(--space-sm)' }}>
              <p>Acil durum bildirilsin mi? Operasyon ekibi hemen devreye girer.</p>
              <ul className={flow.chips} aria-label="Durum türü (isteğe bağlı)">
                {CATEGORIES.map((item) => (
                  <li key={item.value}>
                    <button
                      type="button"
                      className={flow.chip}
                      aria-pressed={category === item.value}
                      onClick={() =>
                        setCategory((prev) => (prev === item.value ? undefined : item.value))
                      }
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
              {panic.error ? <ErrorState {...toDisplayError(panic.error)} /> : null}
              <Button
                variant="danger"
                size="lg"
                fullWidth
                className={flow.panic}
                loading={panic.isPending}
                onClick={() => panic.mutate(data.sessionId)}
              >
                Evet, acil durum bildir
              </Button>
              <Button variant="ghost" onClick={() => setArmed(false)} disabled={panic.isPending}>
                Vazgeç
              </Button>
            </div>
          ) : (
            <div style={{ marginTop: 'var(--space-sm)' }}>
              <Button
                variant="danger"
                size="lg"
                fullWidth
                className={flow.panic}
                onClick={() => setArmed(true)}
              >
                Acil durum
              </Button>
            </div>
          )}
        </Card>
      ) : null}
      {back}
    </div>
  );
}
