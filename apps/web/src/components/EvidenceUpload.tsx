'use client';

import {
  ApiError,
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_MAX_BYTES,
  documentsApi,
  putToSignedUrl,
  sha256Hex,
  type DocumentRegistration,
  type DocumentType,
} from '@emek/api-client';
import { Button, ErrorState, Overline } from '@emek/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { DOCUMENT_TYPE_LABELS } from '@/lib/booking';
import { toDisplayError } from '@/lib/errors';
import { useApi } from '@/providers/AppProviders';
import flow from '@/app/(app)/flow.module.css';

type Stage = 'register' | 'upload' | 'confirm';

const STAGE_LABELS: Record<Stage, string> = {
  register: 'Hazırlanıyor…',
  upload: 'Yükleniyor…',
  confirm: 'Doğrulanıyor…',
};

/** Aynı dosyanın yeniden denemesini tanımak için (içerik değil, kimlik bilgisi). */
const fileKey = (file: File, type: DocumentType) =>
  `${type}:${file.name}:${file.size}:${file.lastModified}:${file.type}`;

/** Bu hatalardan sonra aynı kayıtla devam edilemez: yeni kayıt + yeni imzalı URL gerekir. */
function needsFreshRegistration(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  // İmzalı URL reddi (süre dolmuş olabilir), özet uyuşmazlığı (farklı içerik gitti), kayıt
  // zaten onaylı ya da storage'da nesne yok (yükleme tamamlanmadı).
  return (
    error.code === 'UPLOAD_FAILED' ||
    error.code === 'DOCUMENT_INTEGRITY_MISMATCH' ||
    error.code === 'DOCUMENT_ALREADY_UPLOADED' ||
    error.code === 'DOCUMENT_NOT_FOUND'
  );
}

export function validateEvidenceFile(file: File): string | null {
  if (!(EVIDENCE_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return 'Yalnızca JPEG, PNG, WebP fotoğraf ya da PDF yüklenebilir.';
  }
  if (file.size === 0) return 'Dosya boş.';
  if (file.size > EVIDENCE_MAX_BYTES) return 'Dosya en fazla 10 MB olabilir.';
  return null;
}

/**
 * Kanıt yükleme: kayıt → imzalı URL'e doğrudan PUT → onay (SHA-256 karşılaştırması).
 * Dosya Emek API'sinden geçmez; kaydedilen özet storage'daki nesneden okunur (istemci beyanı
 * yalnızca karşılaştırmadır). Ağ hatasında "Tekrar dene" kaldığı adımdan devam eder — her
 * denemede yeni kayıt açmak, sahipsiz `PENDING` doküman bırakırdı.
 */
export function EvidenceUpload({ bookingId, types }: { bookingId: string; types: DocumentType[] }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [picked, setType] = useState<DocumentType>(types[0]!);
  // Randevu ilerleyince izin verilen türler değişebilir (ör. "önce" artık eklenmez).
  const type = types.includes(picked) ? picked : types[0]!;
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  // Yarım kalan yükleme: kayıt + tamamlanan son adım. Bellekte tutulur, depolamaya yazılmaz.
  const pending = useRef<{
    key: string;
    registration: DocumentRegistration;
    uploaded: boolean;
  } | null>(null);

  const upload = useMutation({
    mutationFn: async ({ file, type }: { file: File; type: DocumentType }) => {
      const documents = documentsApi(api);
      const key = fileKey(file, type);
      if (pending.current?.key !== key) pending.current = null;

      const digest = await sha256Hex(file);
      if (pending.current === null) {
        setStage('register');
        const registration = await documents.register({
          bookingId,
          documentType: type,
          contentType: file.type,
        });
        pending.current = { key, registration, uploaded: false };
      }
      const current = pending.current;
      if (!current.uploaded) {
        setStage('upload');
        await putToSignedUrl(current.registration.uploadUrl, file, file.type);
        current.uploaded = true;
      }
      setStage('confirm');
      return documents.confirm(current.registration.document.id, digest);
    },
    onSuccess: async () => {
      pending.current = null;
      setFile(null);
      if (input.current) input.current.value = '';
      await queryClient.invalidateQueries({ queryKey: ['bookings', bookingId, 'documents'] });
    },
    onError: (error) => {
      if (needsFreshRegistration(error)) pending.current = null;
    },
    onSettled: () => setStage(null),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (file && !fileError) upload.mutate({ file, type });
  }

  return (
    <form className={flow.stack} onSubmit={onSubmit} aria-label="Kanıt ekle">
      <Overline>Fotoğraf ekle</Overline>
      {types.length > 1 ? (
        <ul className={flow.chips} aria-label="Fotoğraf türü">
          {types.map((value) => (
            <li key={value}>
              <button
                type="button"
                className={flow.chip}
                aria-pressed={type === value}
                onClick={() => setType(value)}
              >
                {DOCUMENT_TYPE_LABELS[value]}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={flow.small}>Tür: {DOCUMENT_TYPE_LABELS[type]}</p>
      )}
      <div>
        <label htmlFor={`evidence-${bookingId}`} className={flow.fieldLabel}>
          Dosya
        </label>
        <input
          id={`evidence-${bookingId}`}
          ref={input}
          type="file"
          accept={EVIDENCE_CONTENT_TYPES.join(',')}
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null;
            setFile(picked);
            setFileError(picked ? validateEvidenceFile(picked) : null);
            upload.reset();
          }}
        />
      </div>
      {fileError ? (
        <p role="alert" className={flow.small}>
          {fileError}
        </p>
      ) : null}
      {upload.error ? <ErrorState {...toDisplayError(upload.error)} /> : null}
      {upload.isSuccess ? (
        <p role="status" className={flow.small}>
          Fotoğraf eklendi ve bütünlük özeti kaydedildi.
        </p>
      ) : null}
      <Button
        type="submit"
        variant="secondary"
        disabled={!file || Boolean(fileError)}
        loading={upload.isPending}
      >
        {stage ? STAGE_LABELS[stage] : upload.error ? 'Tekrar dene' : 'Yükle'}
      </Button>
    </form>
  );
}
