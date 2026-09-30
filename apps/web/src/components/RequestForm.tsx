'use client';

import { catalogApi, requestsApi, type BookingRequest } from '@emek/api-client';
import { Button, ErrorState, Skeleton, TextField } from '@emek/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { invalidFields, toDisplayError } from '@/lib/errors';
import { buildWindow, windowFromIso } from '@/lib/request-form';
import { useApi } from '@/providers/AppProviders';
import styles from '@/app/(app)/flow.module.css';

export interface RequestFormProps {
  addressId: string | null;
  /** "Düzelt": ayrıştırılmış talep forma taşınır; kayıt **yeni** talep olarak oluşur. */
  initial?: BookingRequest;
  initialCategory?: string;
  onCreated: (request: BookingRequest) => void;
}

/** Yapılandırılmış talep — AI'ya hiç dokunmaz (T-15: AI kapalıyken core akış çalışır). */
export function RequestForm({ addressId, initial, initialCategory, onCreated }: RequestFormProps) {
  const api = useApi();
  const catalog = catalogApi(api);
  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => catalog.categories(),
  });
  const services = useQuery({
    queryKey: ['catalog', 'services'],
    queryFn: () => catalog.services(),
  });

  const initialWindow = initial
    ? windowFromIso(initial.preferredStart, initial.preferredEnd)
    : null;
  const [category, setCategory] = useState(initialCategory ?? '');
  const [serviceId, setServiceId] = useState(initial?.serviceId ?? '');
  const [date, setDate] = useState(initialWindow?.date ?? '');
  const [from, setFrom] = useState(initialWindow?.from ?? '09:00');
  const [to, setTo] = useState(initialWindow?.to ?? '17:00');
  const [duration, setDuration] = useState(String(initial?.durationMinutes ?? 120));
  const [localError, setLocalError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: Parameters<ReturnType<typeof requestsApi>['fromForm']>[0]) =>
      requestsApi(api).fromForm(body),
    onSuccess: onCreated,
  });

  if (categories.isPending || services.isPending)
    return <Skeleton lines={4} label="Hizmet katalogu yükleniyor" />;
  if (categories.isError || services.isError) {
    const error = categories.error ?? services.error;
    return (
      <ErrorState
        {...toDisplayError(error)}
        onRetry={() => {
          void categories.refetch();
          void services.refetch();
        }}
      />
    );
  }

  const selectedService = services.data.find((s) => s.id === serviceId);
  const effectiveCategory = category || selectedService?.categorySlug || '';
  const visible = services.data.filter(
    (s) => !effectiveCategory || s.categorySlug === effectiveCategory,
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    if (!addressId) return setLocalError('Önce bir hizmet adresi seçin.');
    if (!serviceId) return setLocalError('Bir hizmet seçin.');
    const window = buildWindow({ date, from, to, durationMinutes: Number(duration) });
    if (!window.ok) return setLocalError(window.error);
    create.mutate({
      serviceId,
      addressId,
      preferredStart: window.preferredStart,
      preferredEnd: window.preferredEnd,
      durationMinutes: Number(duration),
    });
  }

  const bad = invalidFields(create.error);
  return (
    <form className={styles.stack} onSubmit={submit} aria-label="Talep formu" noValidate>
      <div className={styles.grid2}>
        <div>
          <label htmlFor="rf-category" className={styles.fieldLabel}>
            Kategori
          </label>
          <select
            id="rf-category"
            className={styles.select}
            value={effectiveCategory}
            onChange={(e) => {
              setCategory(e.target.value);
              setServiceId('');
            }}
          >
            <option value="">Tümü</option>
            {categories.data.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="rf-service" className={styles.fieldLabel}>
            Hizmet
          </label>
          <select
            id="rf-service"
            className={styles.select}
            value={serviceId}
            onChange={(e) => {
              setServiceId(e.target.value);
              const picked = services.data.find((s) => s.id === e.target.value);
              if (picked?.defaultDurationMinutes)
                setDuration(String(picked.defaultDurationMinutes));
            }}
          >
            <option value="">Seçin</option>
            {visible.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className={styles.grid2}>
        <TextField
          label="Tarih"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
        <TextField
          label="Süre (dakika)"
          type="number"
          min={30}
          max={1440}
          step={15}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          error={bad.includes('durationMinutes') ? 'Süre 30–1440 dakika olmalı.' : undefined}
        />
      </div>
      <div className={styles.grid2}>
        <TextField
          label="En erken başlangıç"
          type="time"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          hint="İstanbul saati"
        />
        <TextField
          label="En geç bitiş"
          type="time"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      {localError ? (
        <p role="alert" className={styles.notice}>
          {localError}
        </p>
      ) : null}
      {create.error ? <ErrorState {...toDisplayError(create.error)} /> : null}
      <Button type="submit" loading={create.isPending} fullWidth>
        Talebi oluştur
      </Button>
    </form>
  );
}
