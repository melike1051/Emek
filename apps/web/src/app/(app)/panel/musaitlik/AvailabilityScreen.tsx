'use client';

import { providersApi, type AvailabilityWindow } from '@emek/api-client';
import { Button, Card, ErrorState, Overline, Skeleton, TextField } from '@emek/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { AppShell } from '@/components/AppShell';
import { toDisplayError } from '@/lib/errors';
import { addDays, groupByDay, istanbulDay, istanbulToIso, weekStart } from '@/lib/provider';
import { PROVIDER_KEYS } from '@/lib/provider-queries';
import { useApi } from '@/providers/AppProviders';
import flow from '../../flow.module.css';

const TIME: Intl.DateTimeFormatOptions = { timeStyle: 'short', timeZone: 'Europe/Istanbul' };
const time = (iso: string) => new Date(iso).toLocaleTimeString('tr-TR', TIME);
const dayTitle = (day: string) =>
  new Date(`${day}T12:00:00+03:00`).toLocaleDateString('tr-TR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Istanbul',
  });

/**
 * Haftalık müsaitlik. Saatler **İstanbul saatiyle** girilir ve gösterilir (cihazın saat dilimi
 * değil). Çakışan pencere backend'de reddedilir (`BOOKING_CONFLICT`) ve mesajı gösterilir.
 */
export function AvailabilityScreen() {
  return (
    <AppShell title="Müsaitliğim">
      <Week />
    </AppShell>
  );
}

function Week() {
  const api = useApi();
  const today = istanbulDay(new Date().toISOString());
  const [monday, setMonday] = useState(() => weekStart(today));
  const from = istanbulToIso(monday, '00:00')!;
  const to = istanbulToIso(addDays(monday, 7), '00:00')!;
  const windows = useQuery({
    queryKey: PROVIDER_KEYS.availability(from, to),
    queryFn: () => providersApi(api).availability(from, to),
  });

  return (
    <div className={flow.stack}>
      <div className={flow.between}>
        <Button variant="ghost" onClick={() => setMonday(addDays(monday, -7))}>
          ‹ Önceki hafta
        </Button>
        <Button variant="ghost" onClick={() => setMonday(addDays(monday, 7))}>
          Sonraki hafta ›
        </Button>
      </div>
      {windows.isPending ? (
        <Skeleton lines={5} label="Müsaitlik yükleniyor" />
      ) : windows.isError ? (
        <ErrorState {...toDisplayError(windows.error)} onRetry={() => void windows.refetch()} />
      ) : (
        <ul className={flow.list} aria-label="Hafta">
          {groupByDay(windows.data, monday).map(({ day, windows: dayWindows }) => (
            <li key={day}>
              <DayCard day={day} windows={dayWindows} past={day < today} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DayCard({
  day,
  windows,
  past,
}: {
  day: string;
  windows: AvailabilityWindow[];
  past: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: (id: string) => providersApi(api).removeAvailability(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROVIDER_KEYS.all }),
  });

  return (
    <Card as="article" tone={past ? 'muted' : undefined}>
      <div className={flow.between}>
        <h3>{dayTitle(day)}</h3>
        {!past && !adding ? (
          <Button variant="ghost" onClick={() => setAdding(true)}>
            Saat ekle
          </Button>
        ) : null}
      </div>
      {windows.length === 0 ? (
        <p className={flow.small}>Müsait değilsiniz.</p>
      ) : (
        <ul className={flow.chips} aria-label={`${dayTitle(day)} müsaitlik`}>
          {windows.map((window) => (
            <li key={window.id} className={flow.row}>
              <span>
                {time(window.startsAt)} – {time(window.endsAt)}
              </span>
              {!past ? (
                <Button
                  variant="ghost"
                  aria-label={`${time(window.startsAt)} – ${time(window.endsAt)} aralığını sil`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(window.id)}
                >
                  Sil
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {remove.error ? <ErrorState {...toDisplayError(remove.error)} /> : null}
      {adding ? <AddWindowForm day={day} onDone={() => setAdding(false)} /> : null}
    </Card>
  );
}

function AddWindowForm({ day, onDone }: { day: string; onDone: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const startsAt = istanbulToIso(day, start);
  const endsAt = istanbulToIso(day, end);
  const orderError =
    startsAt && endsAt && startsAt >= endsAt ? 'Bitiş, başlangıçtan sonra olmalı.' : undefined;
  const pastError =
    startsAt && new Date(startsAt).getTime() < Date.now()
      ? 'Geçmiş bir saat eklenemez.'
      : undefined;

  const add = useMutation({
    mutationFn: () => providersApi(api).addAvailability(startsAt!, endsAt!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PROVIDER_KEYS.all });
      onDone();
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (startsAt && endsAt && !orderError && !pastError) add.mutate();
  }

  return (
    <form
      className={flow.stack}
      style={{ marginTop: 'var(--space-sm)' }}
      aria-label="Müsaitlik ekle"
      onSubmit={onSubmit}
    >
      <Overline>Yeni aralık (İstanbul saati)</Overline>
      <div className={flow.grid2}>
        <TextField
          label="Başlangıç"
          type="time"
          step={900}
          value={start}
          error={pastError}
          onChange={(event) => setStart(event.target.value)}
        />
        <TextField
          label="Bitiş"
          type="time"
          step={900}
          value={end}
          error={orderError}
          onChange={(event) => setEnd(event.target.value)}
        />
      </div>
      {add.error ? <ErrorState {...toDisplayError(add.error)} /> : null}
      <div className={flow.row}>
        <Button
          type="submit"
          loading={add.isPending}
          disabled={!startsAt || !endsAt || Boolean(orderError) || Boolean(pastError)}
        >
          Ekle
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={add.isPending}>
          Vazgeç
        </Button>
      </div>
    </form>
  );
}
