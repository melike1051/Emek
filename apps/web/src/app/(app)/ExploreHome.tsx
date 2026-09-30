'use client';

import {
  catalogApi,
  requestsApi,
  type BookingRequest,
  type CreateFromTextResult,
} from '@emek/api-client';
import { Badge, Button, Card, ErrorState, Overline, TextArea } from '@emek/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AddressPicker } from '@/components/AddressPicker';
import { AppShell } from '@/components/AppShell';
import { RequestForm } from '@/components/RequestForm';
import { RequireCustomer } from '@/components/RequireCustomer';
import { toDisplayError } from '@/lib/errors';
import { useApi } from '@/providers/AppProviders';
import flow from './flow.module.css';
import styles from './page.module.css';

/** Backend sınırıyla aynı (services/api/src/requests/booking-requests.constants.ts). */
const MAX_RAW_TEXT_LENGTH = 2000;

type Mode = { kind: 'text' } | { kind: 'form'; category?: string; degraded: boolean };

/** Keşfet & Talep: doğal dil talebi → (gerekirse netleştirme / form) → talep özeti. */
export function ExploreHome() {
  return (
    <AppShell title="Keşfet & Talep">
      <section className={styles.hero}>
        <Badge tone="trust">Komşu dayanışması</Badge>
        <h1>Eviniz ve sevdikleriniz için güvenilir eller.</h1>
        <p className={styles.lead}>
          İhtiyacınızı kendi cümlelerinizle anlatın; kimliği doğrulanmış en uygun sağlayıcıyı sizin
          için bulalım.
        </p>
      </section>
      <RequireCustomer>
        <RequestComposer />
      </RequireCustomer>
    </AppShell>
  );
}

function RequestComposer() {
  const api = useApi();
  const router = useRouter();
  const [addressId, setAddressId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>({ kind: 'text' });
  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => catalogApi(api).categories(),
  });

  const goToRequest = (request: BookingRequest) => router.push(`/talep/${request.id}`);

  const parse = useMutation({
    mutationFn: (input: { rawText: string; addressId: string }) => requestsApi(api).fromText(input),
    onSuccess: (result: CreateFromTextResult) => {
      if (result.status === 'CREATED' && result.request) goToRequest(result.request);
      else if (result.status === 'FORM_REQUIRED') setMode({ kind: 'form', degraded: true });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!addressId || text.trim().length === 0) return;
    parse.mutate({ rawText: text.trim(), addressId });
  }

  const clarifications =
    parse.data?.status === 'NEEDS_CLARIFICATION' ? parse.data.clarifications : [];

  return (
    <div className={flow.stack}>
      <Card>
        <Overline>Adres</Overline>
        <div style={{ marginTop: 'var(--space-sm)' }}>
          <AddressPicker value={addressId} onChange={setAddressId} />
        </div>
      </Card>

      {mode.kind === 'text' ? (
        <Card>
          <form className={flow.stack} onSubmit={submit} aria-label="Doğal dil talebi">
            <TextArea
              label="Neye ihtiyacınız var?"
              hint="Örn. “Cumartesi öğleden sonra 3 saatlik ev temizliği, 2+1 daire.”"
              value={text}
              maxLength={MAX_RAW_TEXT_LENGTH}
              rows={4}
              onChange={(event) => setText(event.target.value)}
            />
            {clarifications.length > 0 ? (
              <div className={flow.notice} role="status">
                <p>
                  <strong>Birkaç ayrıntıyı netleştirelim.</strong> Metninize ekleyip tekrar
                  gönderin:
                </p>
                {clarifications.map((item) => (
                  <div key={item.field} style={{ marginTop: 'var(--space-sm)' }}>
                    <p>{item.question}</p>
                    {item.options.length > 0 ? (
                      <ul className={flow.chips}>
                        {item.options.map((option) => (
                          <li key={option}>
                            <button
                              type="button"
                              className={flow.chip}
                              onClick={() => setText((prev) => `${prev.trimEnd()} ${option}`)}
                            >
                              {option}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {parse.error ? <ErrorState {...toDisplayError(parse.error)} /> : null}
            <Button
              type="submit"
              fullWidth
              loading={parse.isPending}
              disabled={!addressId || text.trim().length === 0}
            >
              Uygun sağlayıcıyı bul
            </Button>
            <Button variant="ghost" onClick={() => setMode({ kind: 'form', degraded: false })}>
              Formla oluştur
            </Button>
          </form>
        </Card>
      ) : (
        <Card>
          {mode.degraded ? (
            <p className={flow.notice} role="status">
              Akıllı talep şu an kullanılamıyor; talebinizi formla oluşturabilirsiniz.
            </p>
          ) : null}
          <div style={{ marginTop: 'var(--space-sm)' }}>
            <RequestForm
              key={mode.category ?? 'all'}
              addressId={addressId}
              {...(mode.category ? { initialCategory: mode.category } : {})}
              onCreated={goToRequest}
            />
          </div>
          <Button variant="ghost" onClick={() => setMode({ kind: 'text' })}>
            Kendi cümlelerimle anlatayım
          </Button>
        </Card>
      )}

      {categories.data && categories.data.length > 0 ? (
        <section aria-label="Hızlı kategori">
          <Overline>Hızlı kategori</Overline>
          <ul className={flow.chips} style={{ marginTop: 'var(--space-sm)' }}>
            {categories.data.map((category) => (
              <li key={category.id}>
                <button
                  type="button"
                  className={flow.chip}
                  aria-pressed={mode.kind === 'form' && mode.category === category.slug}
                  onClick={() =>
                    setMode({ kind: 'form', category: category.slug, degraded: false })
                  }
                >
                  {category.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
