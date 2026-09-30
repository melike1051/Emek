'use client';

import { providersApi, type UpdateProviderProfileInput } from '@emek/api-client';
import { Button, Card, ErrorState, TextArea, TextField } from '@emek/ui';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { AppShell } from '@/components/AppShell';
import { invalidFields, toDisplayError } from '@/lib/errors';
import { useSession } from '@/providers/AppProviders';
import flow from '../../flow.module.css';

const FIELD_ERRORS: Record<string, string> = {
  displayName: 'Ad 2–120 karakter olmalı.',
  bio: 'Tanıtım en fazla 2000 karakter olabilir.',
  experienceYears: 'Deneyim 0–80 yıl arasında olmalı.',
  maxDailyBookings: 'Günlük üst sınır 1–10 arasında olmalı.',
};

/** Profil düzenleme. Sınırlar backend DTO'su ve veritabanı CHECK'leriyle aynıdır. */
export function ProviderProfileScreen() {
  return (
    <AppShell title="Profilim">
      <ProfileForm />
    </AppShell>
  );
}

function ProfileForm() {
  const { api, session, refreshSession } = useSession();
  const provider = session!.provider!;
  const [displayName, setDisplayName] = useState(provider.displayName);
  const [bio, setBio] = useState(provider.bio ?? '');
  const [experience, setExperience] = useState(provider.experienceYears?.toString() ?? '');
  const [maxDaily, setMaxDaily] = useState(String(provider.maxDailyBookings));

  const save = useMutation({
    mutationFn: (body: UpdateProviderProfileInput) => providersApi(api).update(body),
    onSuccess: () => refreshSession(),
  });

  const experienceValue =
    experience.trim() === '' ? undefined : Number(experience.replace(',', '.'));
  const localErrors: Record<string, string> = {};
  if (displayName.trim().length < 2) localErrors.displayName = FIELD_ERRORS.displayName!;
  if (
    experienceValue !== undefined &&
    (!Number.isFinite(experienceValue) || experienceValue < 0 || experienceValue > 80)
  ) {
    localErrors.experienceYears = FIELD_ERRORS.experienceYears!;
  }
  const serverErrors = Object.fromEntries(
    invalidFields(save.error).map((field) => [field, FIELD_ERRORS[field] ?? 'Geçersiz değer.']),
  );
  const errors = { ...serverErrors, ...localErrors };

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (Object.keys(localErrors).length > 0) return;
    save.mutate({
      displayName: displayName.trim(),
      bio: bio.trim(),
      ...(experienceValue !== undefined
        ? { experienceYears: Math.round(experienceValue * 10) / 10 }
        : {}),
      maxDailyBookings: Number(maxDaily),
    });
  }

  return (
    <Card>
      <form className={flow.stack} onSubmit={onSubmit} aria-label="Profil">
        <TextField
          label="Görünen ad"
          value={displayName}
          maxLength={120}
          error={errors.displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <TextArea
          label="Kendinizi tanıtın"
          hint="Müşteriler eşleştiğinde bunu görür. Telefon, adres gibi iletişim bilgisi yazmayın."
          value={bio}
          maxLength={2000}
          rows={5}
          error={errors.bio}
          onChange={(event) => setBio(event.target.value)}
        />
        <div className={flow.grid2}>
          <TextField
            label="Deneyim (yıl)"
            inputMode="decimal"
            value={experience}
            error={errors.experienceYears}
            onChange={(event) => setExperience(event.target.value)}
          />
          <div>
            <label htmlFor="max-daily" className={flow.fieldLabel}>
              Günde en fazla randevu
            </label>
            <select
              id="max-daily"
              className={flow.select}
              value={maxDaily}
              onChange={(event) => setMaxDaily(event.target.value)}
            >
              {Array.from({ length: 10 }, (_, index) => String(index + 1)).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>
        {save.error && Object.keys(serverErrors).length === 0 ? (
          <ErrorState {...toDisplayError(save.error)} />
        ) : null}
        {save.isSuccess ? (
          <p role="status" className={flow.small}>
            Profiliniz kaydedildi.
          </p>
        ) : null}
        <Button type="submit" loading={save.isPending}>
          Kaydet
        </Button>
      </form>
    </Card>
  );
}
