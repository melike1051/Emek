'use client';

import { addressesApi, providersApi, type ServiceArea } from '@emek/api-client';
import { Button, Card, EmptyState, ErrorState, Overline, Skeleton, TextField } from '@emek/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { addressLabel, ADDRESSES_KEY } from '@/components/AddressPicker';
import { AppShell } from '@/components/AppShell';
import { ConfirmStep } from '@/components/BookingCards';
import { invalidFields, toDisplayError } from '@/lib/errors';
import { RADIUS_OPTIONS_KM, formatRadius } from '@/lib/provider';
import { PROVIDER_KEYS } from '@/lib/provider-queries';
import { useApi } from '@/providers/AppProviders';
import flow from '../../flow.module.css';

/** Backend sınırı (PROVIDER_SERVICE_AREA_LIMIT, veritabanında 5). */
const MAX_AREAS = 5;

/**
 * Hizmet bölgeleri: merkez + yarıçap (serbest poligon yok). Birbirine değmeyen bölgeler ayrı
 * kayıtlarla ifade edilir. Merkez tarayıcı konumundan, kayıtlı adresten ya da elle girilir.
 * TODO(faz-15): adres → koordinat (geocoding) ucu yok (R-101).
 */
export function ServiceAreasScreen() {
  return (
    <AppShell title="Hizmet bölgelerim">
      <Areas />
    </AppShell>
  );
}

function Areas() {
  const api = useApi();
  const areas = useQuery({
    queryKey: PROVIDER_KEYS.areas,
    queryFn: () => providersApi(api).serviceAreas(),
  });
  if (areas.isPending) return <Skeleton lines={3} label="Bölgeler yükleniyor" />;
  if (areas.isError) {
    return <ErrorState {...toDisplayError(areas.error)} onRetry={() => void areas.refetch()} />;
  }
  const list = areas.data;
  return (
    <div className={flow.stack}>
      {list.length === 0 ? (
        <EmptyState
          title="Henüz hizmet bölgeniz yok"
          description="Bölge eklemeden size talep gelmez. Çalıştığınız semtin merkezini ve ne kadar uzağa gidebileceğinizi seçin."
        />
      ) : (
        <ul className={flow.list} aria-label="Bölgeler">
          {list.map((area) => (
            <li key={area.id}>
              <AreaCard area={area} />
            </li>
          ))}
        </ul>
      )}
      {list.length < MAX_AREAS ? (
        <AddAreaForm />
      ) : (
        <p className={flow.small}>En fazla {MAX_AREAS} bölge ekleyebilirsiniz.</p>
      )}
    </div>
  );
}

function AreaCard({ area }: { area: ServiceArea }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => providersApi(api).removeServiceArea(area.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROVIDER_KEYS.areas }),
  });
  return (
    <Card as="article">
      <div className={flow.between}>
        <div>
          <h3>{area.name}</h3>
          <p className={flow.small}>
            Merkezden {formatRadius(area.radiusMeters)} · {area.latitude.toFixed(4)},{' '}
            {area.longitude.toFixed(4)}
          </p>
        </div>
      </div>
      {remove.error ? <ErrorState {...toDisplayError(remove.error)} /> : null}
      <div style={{ marginTop: 'var(--space-sm)' }}>
        <ConfirmStep
          label="Bölgeyi kaldır"
          confirmLabel="Evet, kaldır"
          variant="danger"
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
    </Card>
  );
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

function AddAreaForm() {
  const api = useApi();
  const queryClient = useQueryClient();
  const addresses = useQuery({ queryKey: ADDRESSES_KEY, queryFn: () => addressesApi(api).list() });
  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [radiusKm, setRadiusKm] = useState<number>(5);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      providersApi(api).addServiceArea({
        name: name.trim(),
        latitude: round6(Number(lat)),
        longitude: round6(Number(lng)),
        radiusMeters: radiusKm * 1000,
      }),
    onSuccess: async () => {
      setName('');
      setLat('');
      setLng('');
      await queryClient.invalidateQueries({ queryKey: PROVIDER_KEYS.areas });
    },
  });

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
        setLat(position.coords.latitude.toFixed(6));
        setLng(position.coords.longitude.toFixed(6));
      },
      () => {
        setLocating(false);
        setGeoError('Konum alınamadı. Kayıtlı bir adres seçebilir ya da koordinat girebilirsiniz.');
      },
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  }

  const latNum = Number(lat);
  const lngNum = Number(lng);
  const coordsValid =
    lat !== '' &&
    lng !== '' &&
    Number.isFinite(latNum) &&
    Number.isFinite(lngNum) &&
    Math.abs(latNum) <= 90 &&
    Math.abs(lngNum) <= 180;
  const nameValid = name.trim().length >= 2;
  const serverFields = new Set(invalidFields(add.error));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (coordsValid && nameValid) add.mutate();
  }

  return (
    <Card>
      <form className={flow.stack} onSubmit={onSubmit} aria-label="Bölge ekle">
        <Overline>Yeni bölge</Overline>
        <TextField
          label="Bölge adı"
          hint="Örn. Kadıköy ve çevresi"
          value={name}
          maxLength={80}
          error={serverFields.has('name') ? 'Ad 2–80 karakter olmalı.' : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        <div className={flow.stack} style={{ gap: 'var(--space-xs)' }}>
          <span className={flow.fieldLabel}>Merkez</span>
          <div className={flow.row}>
            <Button variant="secondary" loading={locating} onClick={locate}>
              Konumumu kullan
            </Button>
            {addresses.data && addresses.data.length > 0 ? (
              <select
                aria-label="Kayıtlı adresten seç"
                className={flow.select}
                value=""
                onChange={(event) => {
                  const address = addresses.data.find((a) => a.id === event.target.value);
                  if (address) {
                    setLat(address.latitude.toFixed(6));
                    setLng(address.longitude.toFixed(6));
                    if (!name.trim()) setName(address.district);
                  }
                }}
              >
                <option value="">Kayıtlı adresten seç</option>
                {addresses.data.map((address) => (
                  <option key={address.id} value={address.id}>
                    {addressLabel(address)}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          {geoError ? <p className={flow.small}>{geoError}</p> : null}
        </div>
        <div className={flow.grid2}>
          <TextField
            label="Enlem"
            inputMode="decimal"
            value={lat}
            onChange={(event) => setLat(event.target.value)}
          />
          <TextField
            label="Boylam"
            inputMode="decimal"
            value={lng}
            onChange={(event) => setLng(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="radius" className={flow.fieldLabel}>
            Ne kadar uzağa gidebilirsiniz?
          </label>
          <select
            id="radius"
            className={flow.select}
            value={radiusKm}
            onChange={(event) => setRadiusKm(Number(event.target.value))}
          >
            {RADIUS_OPTIONS_KM.map((km) => (
              <option key={km} value={km}>
                {km} km
              </option>
            ))}
          </select>
        </div>
        {add.error && serverFields.size === 0 ? (
          <ErrorState {...toDisplayError(add.error)} />
        ) : null}
        <Button type="submit" disabled={!coordsValid || !nameValid} loading={add.isPending}>
          Bölgeyi ekle
        </Button>
      </form>
    </Card>
  );
}
