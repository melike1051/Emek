'use client';

import { ApiError } from '@emek/api-client';
import { Button, TextArea } from '@emek/ui';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { toDisplayError } from '@/lib/errors';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { useStaff } from '@/providers/AppProviders';
import styles from './admin.module.css';

export interface ReasonSpec {
  label: string;
  required: boolean;
  minLength?: number;
  maxLength: number;
  hint?: string;
}

export interface ActionPanelProps<R> {
  /** Paneli açan düğme. */
  trigger: string;
  title: string;
  description?: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  confirmLabel: string;
  reason?: ReasonSpec;
  /** Doluysa onay düğmesi bu kutu işaretlenmeden açılmaz (para/veri silme — çift onay). */
  acknowledge?: string;
  /** Ek alanlar (tutar, karar türü…) — durumu çağıran tutar. */
  extra?: ReactNode;
  /** Ek alanlar geçerli mi; `false` onayı kapatır. */
  extraValid?: boolean;
  /**
   * Gövdenin özeti. Değiştiğinde `Idempotency-Key` yenilenir: aynı anahtar farklı gövdeyle
   * backend'de `IDEMPOTENCY_KEY_REUSED` olur. Aynı gövdenin tekrarı aynı anahtarı taşır.
   */
  payloadSignature?: string;
  run: (input: { reason: string | undefined; idempotencyKey: string }) => Promise<R>;
  /** Başarıdan sonra tazelenecek sorgular. */
  invalidate: QueryKey[];
  onDone?: (result: R) => void;
}

/**
 * Tek yazma eylemi deseni: aç → (gerekçe/ek alan) → onayla. Yalnız ADMIN'e gösterilir; SUPPORT
 * için hiç render edilmez. Yetki yine de backend'dedir — 403 dahil her ret mesajıyla gösterilir.
 * Mutasyon otomatik tekrar denenmez; "Onayla"ya yeniden basmak aynı anahtarla gider.
 *
 * Belirsiz hatadan (ağ, 5xx, `IDEMPOTENCY_IN_PROGRESS`) sonra girdiler kilitlenir: istek sunucuda
 * işlenmiş olabilir; gövde değişirse yeni anahtar ikinci bir iade/karar üretirdi. Yalnız aynı
 * gövdenin aynı anahtarla tekrarı mümkündür.
 */
export function ActionPanel<R>(props: ActionPanelProps<R>) {
  const { canWrite } = useStaff();
  const [open, setOpen] = useState(false);
  if (!canWrite) return null;
  if (!open) {
    return (
      <Button variant={props.variant ?? 'secondary'} onClick={() => setOpen(true)}>
        {props.trigger}
      </Button>
    );
  }
  return <OpenPanel {...props} onClose={() => setOpen(false)} />;
}

function OpenPanel<R>({
  title,
  description,
  variant = 'secondary',
  confirmLabel,
  reason: reasonSpec,
  acknowledge,
  extra,
  extraValid = true,
  payloadSignature = '',
  run,
  invalidate,
  onDone,
  onClose,
}: ActionPanelProps<R> & { onClose: () => void }) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const { current: currentKey, rotate: rotateKey } = useIdempotencyKey();

  const [locked, setLocked] = useState(false);

  const trimmed = reason.trim();
  const signature = `${trimmed}\u0000${payloadSignature}`;
  useEffect(() => {
    if (!locked) rotateKey();
  }, [signature, rotateKey, locked]);

  const mutation = useMutation({
    mutationFn: () =>
      run({ reason: trimmed.length > 0 ? trimmed : undefined, idempotencyKey: currentKey() }),
    onSuccess: async (result) => {
      rotateKey();
      await Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      onDone?.(result);
      onClose();
    },
    onError: (error) => {
      if (isAmbiguousFailure(error)) setLocked(true);
    },
  });

  const reasonError =
    reasonSpec &&
    trimmed.length > 0 &&
    reasonSpec.minLength &&
    trimmed.length < reasonSpec.minLength
      ? `En az ${reasonSpec.minLength} karakter yazın.`
      : undefined;
  const reasonOk =
    !reasonSpec ||
    ((!reasonSpec.required || trimmed.length > 0) &&
      trimmed.length <= reasonSpec.maxLength &&
      reasonError === undefined);
  const ready = reasonOk && extraValid && (!acknowledge || acknowledged);

  return (
    <div
      className={`${styles.panel} ${variant === 'danger' ? styles.panelDanger : ''}`}
      role="group"
      aria-labelledby={headingId}
    >
      <strong id={headingId}>{title}</strong>
      {description ? <div className={styles.small}>{description}</div> : null}
      <fieldset disabled={locked} className={styles.lockable}>
        {extra}
        {reasonSpec ? (
          <TextArea
            label={reasonSpec.label}
            hint={reasonSpec.hint ?? (reasonSpec.required ? undefined : 'İsteğe bağlı')}
            value={reason}
            maxLength={reasonSpec.maxLength}
            onChange={(event) => setReason(event.target.value)}
            error={reasonError}
            rows={2}
          />
        ) : null}
      </fieldset>
      {acknowledge ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>{acknowledge}</span>
        </label>
      ) : null}
      {mutation.isError ? <ActionError error={mutation.error} /> : null}
      {locked ? (
        <p className={styles.small}>
          İşlem sunucuda gerçekleşmiş olabilir. Bilgiler kilitlendi: yalnız aynı isteği tekrar
          deneyebilirsiniz. Değişiklik gerekiyorsa paneli kapatıp kaydın güncel durumunu kontrol
          edin.
        </p>
      ) : null}
      <div className={styles.row}>
        <Button
          variant={variant === 'danger' ? 'danger' : 'primary'}
          disabled={!ready}
          loading={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isError ? 'Tekrar dene' : confirmLabel}
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
          Vazgeç
        </Button>
      </div>
    </div>
  );
}

function ActionError({ error }: { error: unknown }) {
  const { message, requestId } = toDisplayError(error);
  return (
    <p role="alert" className={styles.small}>
      {message}
      {requestId ? ` (Referans: ${requestId})` : ''}
    </p>
  );
}

/** Sunucunun isteği işleyip işlemediği bilinmeyen hatalar. */
function isAmbiguousFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status >= 500 || error.code === 'IDEMPOTENCY_IN_PROGRESS';
}
