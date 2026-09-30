'use client';

import { catalogApi, providersApi, type SkillLevel } from '@emek/api-client';
import { Badge, Button, Card, ErrorState, Overline, Skeleton } from '@emek/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { toDisplayError } from '@/lib/errors';
import { PROVIDER_KEYS } from '@/lib/provider-queries';
import { useApi } from '@/providers/AppProviders';
import flow from '../../flow.module.css';

const LEVEL_LABELS: Record<SkillLevel, string> = {
  BEGINNER: 'Başlangıç',
  INTERMEDIATE: 'Orta',
  EXPERT: 'Uzman',
};

/**
 * Sunulan hizmetler + beceriler. Aday havuzu **beyan edilen hizmetten** başlar; beceriler
 * operatör doğrulayana kadar eşleştirmede sayılmaz (Faz 7 hard constraint).
 */
export function ServicesScreen() {
  return (
    <AppShell title="Hizmetlerim">
      <div className={flow.stack}>
        <OfferedServices />
        <Skills />
      </div>
    </AppShell>
  );
}

function OfferedServices() {
  const api = useApi();
  const queryClient = useQueryClient();
  const providers = providersApi(api);
  const catalog = useQuery({
    queryKey: ['catalog', 'services'],
    queryFn: () => catalogApi(api).services(),
  });
  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => catalogApi(api).categories(),
  });
  const offered = useQuery({ queryKey: PROVIDER_KEYS.services, queryFn: providers.services });
  const toggle = useMutation({
    mutationFn: async ({ serviceId, on }: { serviceId: string; on: boolean }) => {
      if (on) await providers.addService(serviceId);
      else await providers.removeService(serviceId);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROVIDER_KEYS.services }),
  });

  if (catalog.isPending || offered.isPending) {
    return <Skeleton lines={4} label="Hizmetler yükleniyor" />;
  }
  const failed = [catalog, offered].find((query) => query.isError);
  if (failed) {
    return <ErrorState {...toDisplayError(failed.error)} onRetry={() => void failed.refetch()} />;
  }

  const active = new Set(offered.data!.filter((s) => s.active).map((s) => s.serviceId));
  const groups = (categories.data ?? []).map((category) => ({
    category,
    services: catalog.data!.filter((service) => service.categoryId === category.id),
  }));
  // Kategori listesi gelmediyse hizmetler tek grupta gösterilir (katalog yine de kullanılabilir).
  const shown = groups.length > 0 ? groups : [{ category: null, services: catalog.data! }];

  return (
    <Card>
      <Overline>Sunduğunuz hizmetler</Overline>
      <p className={flow.small} style={{ margin: 'var(--space-xs) 0 var(--space-sm)' }}>
        Yalnızca seçtiğiniz hizmetler için size talep gelir.
      </p>
      {toggle.error ? <ErrorState {...toDisplayError(toggle.error)} /> : null}
      <div className={flow.stack}>
        {shown
          .filter((group) => group.services.length > 0)
          .map((group) => (
            <section
              key={group.category?.id ?? 'all'}
              aria-label={group.category?.name ?? 'Hizmetler'}
            >
              {group.category ? <h3 className={flow.fieldLabel}>{group.category.name}</h3> : null}
              <ul className={flow.chips}>
                {group.services.map((service) => {
                  const on = active.has(service.id);
                  return (
                    <li key={service.id}>
                      <button
                        type="button"
                        className={flow.chip}
                        aria-pressed={on}
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate({ serviceId: service.id, on: !on })}
                      >
                        {/* Seçim yalnızca renkle anlatılmaz (WCAG 1.4.1); durum aria-pressed'dedir. */}
                        {on ? <span aria-hidden="true">✓ </span> : null}
                        {service.name}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
      </div>
    </Card>
  );
}

function Skills() {
  const api = useApi();
  const queryClient = useQueryClient();
  const providers = providersApi(api);
  const [skillId, setSkillId] = useState('');
  const [level, setLevel] = useState<SkillLevel>('INTERMEDIATE');
  const catalog = useQuery({
    queryKey: ['catalog', 'skills'],
    queryFn: () => catalogApi(api).skills(),
  });
  const mine = useQuery({ queryKey: PROVIDER_KEYS.skills, queryFn: providers.skills });
  const add = useMutation({
    mutationFn: () => providers.addSkill(skillId, level),
    onSuccess: (skills) => {
      queryClient.setQueryData(PROVIDER_KEYS.skills, skills);
      setSkillId('');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => providers.removeSkill(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROVIDER_KEYS.skills }),
  });

  if (catalog.isPending || mine.isPending)
    return <Skeleton lines={3} label="Beceriler yükleniyor" />;
  const failed = [catalog, mine].find((query) => query.isError);
  if (failed) {
    return <ErrorState {...toDisplayError(failed.error)} onRetry={() => void failed.refetch()} />;
  }

  const owned = new Set(mine.data!.map((skill) => skill.skillId));
  const available = catalog.data!.filter((skill) => !owned.has(skill.id));

  return (
    <Card>
      <Overline>Becerileriniz</Overline>
      <p className={flow.small} style={{ margin: 'var(--space-xs) 0 var(--space-sm)' }}>
        Beceriler ekibimiz tarafından doğrulandıktan sonra eşleştirmede dikkate alınır.
      </p>
      {mine.data!.length > 0 ? (
        <ul className={flow.list}>
          {mine.data!.map((skill) => (
            <li key={skill.skillId} className={flow.between}>
              <span>
                {skill.name} ·{' '}
                <span className={flow.muted}>{LEVEL_LABELS[skill.level] ?? skill.level}</span>
              </span>
              <span className={flow.row}>
                <Badge tone={skill.verified ? 'trust' : 'neutral'}>
                  {skill.verified ? 'Doğrulandı' : 'Doğrulama bekliyor'}
                </Badge>
                <Button
                  variant="ghost"
                  aria-label={`${skill.name} becerisini kaldır`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(skill.skillId)}
                >
                  Kaldır
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {remove.error ? <ErrorState {...toDisplayError(remove.error)} /> : null}
      {available.length > 0 ? (
        <form
          className={flow.stack}
          style={{ marginTop: 'var(--space-md)' }}
          aria-label="Beceri ekle"
          onSubmit={(event) => {
            event.preventDefault();
            if (skillId) add.mutate();
          }}
        >
          <div className={flow.grid2}>
            <div>
              <label htmlFor="skill" className={flow.fieldLabel}>
                Beceri
              </label>
              <select
                id="skill"
                className={flow.select}
                value={skillId}
                onChange={(event) => setSkillId(event.target.value)}
              >
                <option value="">Seçin</option>
                {available.map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="skill-level" className={flow.fieldLabel}>
                Seviye
              </label>
              <select
                id="skill-level"
                className={flow.select}
                value={level}
                onChange={(event) => setLevel(event.target.value as SkillLevel)}
              >
                {(Object.keys(LEVEL_LABELS) as SkillLevel[]).map((value) => (
                  <option key={value} value={value}>
                    {LEVEL_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {add.error ? <ErrorState {...toDisplayError(add.error)} /> : null}
          <Button type="submit" variant="secondary" disabled={!skillId} loading={add.isPending}>
            Beceri ekle
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
