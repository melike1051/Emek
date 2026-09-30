'use client';

import { addressesApi, type Address, type CreateAddressInput } from '@emek/api-client';
import { Button, ErrorState, Skeleton, TextField } from '@emek/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { invalidFields, toDisplayError } from '@/lib/errors';
import { useApi } from '@/providers/AppProviders';
import styles from '@/app/(app)/flow.module.css';

export const ADDRESSES_KEY = ['addresses'] as const;

export function addressLabel(address: Address): string {
  const place = `${address.district}, ${address.city}`;
  return address.label ? `${address.label} — ${place}` : place;
}

/**
 * Talep adresi seçimi + yerinde ekleme. Koordinat zorunludur (eşleştirme PostGIS mesafesiyle
 * çalışır); tarayıcı konumu önerilir, elle giriş yedektir.
 * TODO(faz-15): adres → koordinat için geocoding (Google Maps Platform) — backend ucu yok.
 */
export function AddressPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string) => void;
}) {
  const api = useApi();
  const addresses = useQuery({ queryKey: ADDRESSES_KEY, queryFn: () => addressesApi(api).list() });
  const [adding, setAdding] = useState(false);

  // Tek adres varsa ya da seçim geçersizleştiyse ilk adres seçilir.
  const list = addresses.data;
  useEffect(() => {
    if (list && list.length > 0 && !list.some((a) => a.id === value)) onChange(list[0]!.id);
  }, [list, value, onChange]);

  if (addresses.isPending) return <Skeleton lines={1} label="Adresler yükleniyor" />;
  if (addresses.isError) {
    return (
      <ErrorState {...toDisplayError(addresses.error)} onRetry={() => void addresses.refetch()} />
    );
  }

  const showForm = adding || addresses.data.length === 0;
  return (
    <div className={styles.stack}>
      {addresses.data.length > 0 ? (
        <div>
          <label htmlFor="address-select" className={styles.fieldLabel}>
            Hizmet adresi
          </label>
          <select
            id="address-select"
            className={styles.select}
            value={value ?? ''}
            onChange={(event) => onChange(event.target.value)}
          >
            {addresses.data.map((address) => (
              <option key={address.id} value={address.id}>
                {addressLabel(address)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {showForm ? (
        <NewAddressForm
          onCreated={(id) => {
            setAdding(false);
            onChange(id);
          }}
          onCancel={addresses.data.length > 0 ? () => setAdding(false) : undefined}
        />
      ) : (
        <Button variant="ghost" onClick={() => setAdding(true)}>
          Yeni adres ekle
        </Button>
      )}
    </div>
  );
}

function NewAddressForm({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => void;
  onCancel: (() => void) | undefined;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    label: '',
    city: '',
    district: '',
    line: '',
    lat: '',
    lng: '',
  });
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: CreateAddressInput) => addressesApi(api).create(body),
    onSuccess: async (address) => {
      await queryClient.invalidateQueries({ queryKey: ADDRESSES_KEY });
      onCreated(address.id);
    },
  });

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  function locate() {
    if (!('geolocation' in navigator)) {
      setGeoError('Tarayıcınız konum paylaşımını desteklemiyor.');
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        setForm((prev) => ({
          ...prev,
          lat: position.coords.latitude.toFixed(6),
          lng: position.coords.longitude.toFixed(6),
        }));
      },
      () => {
        setLocating(false);
        setGeoError('Konum alınamadı. Koordinatları elle girebilirsiniz.');
      },
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  }

  const lat = Number(form.lat);
  const lng = Number(form.lng);
  const coordsValid =
    form.lat !== '' && form.lng !== '' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const bad = invalidFields(create.error);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!coordsValid) return;
    create.mutate({
      ...(form.label.trim() ? { label: form.label.trim() } : {}),
      city: form.city.trim(),
      district: form.district.trim(),
      line: form.line.trim(),
      latitude: lat,
      longitude: lng,
    });
  }

  return (
    <form className={styles.stack} onSubmit={submit} aria-label="Yeni adres">
      <TextField
        label="Etiket (isteğe bağlı)"
        value={form.label}
        onChange={set('label')}
        maxLength={60}
        placeholder="Ev"
      />
      <div className={styles.grid2}>
        <TextField
          label="İl"
          value={form.city}
          onChange={set('city')}
          required
          minLength={2}
          maxLength={100}
          error={bad.includes('city') ? 'İl adını kontrol edin.' : undefined}
        />
        <TextField
          label="İlçe"
          value={form.district}
          onChange={set('district')}
          required
          minLength={2}
          maxLength={100}
          error={bad.includes('district') ? 'İlçe adını kontrol edin.' : undefined}
        />
      </div>
      <TextField
        label="Açık adres"
        value={form.line}
        onChange={set('line')}
        required
        minLength={5}
        maxLength={500}
        error={bad.includes('line') ? 'Açık adres en az 5 karakter olmalı.' : undefined}
      />
      <div className={styles.row}>
        <Button variant="secondary" onClick={locate} loading={locating}>
          Konumumu kullan
        </Button>
        {geoError ? (
          <span className={styles.small} role="status">
            {geoError}
          </span>
        ) : null}
      </div>
      <div className={styles.grid2}>
        <TextField
          label="Enlem"
          inputMode="decimal"
          value={form.lat}
          onChange={set('lat')}
          required
        />
        <TextField
          label="Boylam"
          inputMode="decimal"
          value={form.lng}
          onChange={set('lng')}
          required
        />
      </div>
      {create.error && bad.length === 0 ? <ErrorState {...toDisplayError(create.error)} /> : null}
      <div className={styles.row}>
        <Button type="submit" loading={create.isPending} disabled={!coordsValid}>
          Adresi kaydet
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Vazgeç
          </Button>
        ) : null}
      </div>
    </form>
  );
}
