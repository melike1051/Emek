'use client';

import { Badge, Button, Card, ErrorState, Overline, TextArea, TextField } from '@emek/ui';
import { profilesApi } from '@emek/api-client';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { invalidFields, toDisplayError } from '@/lib/errors';
import { defaultHome } from '@/lib/session';
import { useSession } from '@/providers/AppProviders';
import authStyles from '../auth.module.css';
import styles from './RoleSelect.module.css';

type Role = 'customer' | 'provider';

const ROLES: Record<
  Role,
  { title: string; subtitle: string; body: string; badges: [string, string] }
> = {
  customer: {
    title: 'Hizmet almak istiyorum',
    subtitle: 'Hane & günlük destek',
    body: 'Mahallenizdeki kimliği doğrulanmış sağlayıcılarla tanışın; eviniz ve sevdikleriniz için destek alın.',
    badges: ['Onaylı sağlayıcılar', 'Şartlı ödeme güvencesi'],
  },
  provider: {
    title: 'Emeğimi sunmak istiyorum',
    subtitle: 'Hizmet sağlayıcı',
    body: 'Becerilerinizi komşularınıza ulaştırın; müsaitliğinizi ve hizmet bölgenizi siz belirleyin.',
    badges: ['Esnek çalışma', 'Başvuru incelemesi'],
  },
};

export function RoleSelect() {
  const { api, session, refreshSession } = useSession();
  const router = useRouter();
  const [role, setRole] = useState<Role | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [experience, setExperience] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();

  const available = (Object.keys(ROLES) as Role[]).filter((key) =>
    key === 'customer' ? !session?.customer : !session?.provider,
  );
  const nothingToAdd = available.length === 0;

  const create = useMutation({
    mutationFn: async (selected: Role) => {
      const profiles = profilesApi(api);
      if (selected === 'customer') {
        await profiles.createCustomer({ displayName: displayName.trim() });
      } else {
        await profiles.createProvider({
          displayName: displayName.trim(),
          ...(bio.trim() ? { bio: bio.trim() } : {}),
          ...(experience ? { experienceYears: Number(experience) } : {}),
        });
      }
    },
    onSuccess: async (_data, selected) => {
      await refreshSession();
      router.replace(selected === 'provider' ? '/panel' : '/');
    },
  });

  // Eklenecek profil kalmadıysa çık — ama yeni oluşturulan profilin kendi hedefine gitmesini bozmadan.
  useEffect(() => {
    if (nothingToAdd && session && create.isIdle) router.replace(defaultHome(session));
  }, [nothingToAdd, session, create.isIdle, router]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!role) return;
    const trimmed = displayName.trim();
    if (trimmed.length < 2 || trimmed.length > 120) {
      setNameError('Adınız 2–120 karakter olmalı.');
      return;
    }
    setNameError(undefined);
    create.mutate(role);
  }

  if (available.length === 0) return null;
  const isFirstProfile = available.length === 2;

  const serverError = create.error ? toDisplayError(create.error) : null;
  const badFields = invalidFields(create.error);
  const nameRejected = badFields.includes('displayName');

  return (
    <form onSubmit={submit} noValidate className={styles.layout}>
      <div className={authStyles.intro}>
        <Overline>{isFirstProfile ? 'Rol belirleme' : 'Profil ekle'}</Overline>
        {isFirstProfile ? (
          <>
            <h1>Emek&apos;te nasıl yer almak istersiniz?</h1>
            <p className={authStyles.lead}>
              Tek hesapla hem hizmet alabilir hem emeğinizi sunabilirsiniz. Diğer profili daha sonra
              hesabınızdan ekleyebilirsiniz.
            </p>
          </>
        ) : (
          <>
            <h1>İkinci profilinizi ekleyin</h1>
            <p className={authStyles.lead}>
              Aynı hesapla devam edersiniz; iki profil arasında üst menüden geçiş yapabilirsiniz.
            </p>
          </>
        )}
      </div>

      <fieldset className={styles.roles}>
        <legend className="emek-visually-hidden">Rol</legend>
        {available.map((key) => {
          const item = ROLES[key];
          return (
            <label key={key} className={styles.roleCard} data-selected={role === key || undefined}>
              <input
                type="radio"
                name="role"
                value={key}
                checked={role === key}
                onChange={() => setRole(key)}
                className={styles.radio}
              />
              <span className={styles.roleHead}>
                <span>
                  <span className={styles.roleTitle}>{item.title}</span>
                  <span className={styles.roleSubtitle}>{item.subtitle}</span>
                </span>
                <span className={styles.tick} aria-hidden="true" />
              </span>
              <span className={styles.roleBody}>{item.body}</span>
              <span className={styles.badges}>
                <Badge tone="trust">{item.badges[0]}</Badge>
                <Badge tone="highlight">{item.badges[1]}</Badge>
              </span>
            </label>
          );
        })}
      </fieldset>

      {role ? (
        <Card className={styles.details}>
          <TextField
            label={role === 'provider' ? 'Görünen adınız' : 'Adınız'}
            hint="Karşı tarafa bu ad gösterilir (ör. Hatice Y.)."
            autoComplete="name"
            maxLength={120}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            error={
              nameError ??
              (nameRejected ? 'Bu ad kabul edilmedi; 2–120 karakter olmalı.' : undefined)
            }
            required
          />
          {role === 'provider' ? (
            <>
              <TextArea
                label="Kendinizi tanıtın (isteğe bağlı)"
                maxLength={2000}
                value={bio}
                onChange={(event) => setBio(event.target.value)}
              />
              <TextField
                label="Deneyim (yıl, isteğe bağlı)"
                type="number"
                inputMode="decimal"
                min={0}
                max={80}
                step={0.5}
                value={experience}
                onChange={(event) => setExperience(event.target.value)}
              />
              <p className={styles.note}>
                Sağlayıcı profiliniz önce taslak olarak oluşturulur; hizmet, bölge ve müsaitlik
                bilgilerinizi ekleyip incelemeye gönderdiğinizde yayına alınır.
              </p>
            </>
          ) : null}
        </Card>
      ) : null}

      {serverError && !nameRejected ? <ErrorState {...serverError} /> : null}

      <div className={styles.cta}>
        <Button type="submit" size="lg" fullWidth disabled={!role} loading={create.isPending}>
          Devam et →
        </Button>
        {!isFirstProfile ? (
          <p className={authStyles.footnote}>
            <Link href="/hesap">Vazgeç</Link>
          </p>
        ) : null}
      </div>
    </form>
  );
}
