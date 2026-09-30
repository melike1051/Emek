'use client';

import { documentsApi, type EvidenceDocument } from '@emek/api-client';
import { Badge, Button, Card, ErrorState, Overline } from '@emek/ui';
import { useMutation } from '@tanstack/react-query';
import { DOCUMENT_TYPE_LABELS, formatDateTime } from '@/lib/booking';
import { toDisplayError } from '@/lib/errors';
import { useApi } from '@/providers/AppProviders';
import flow from '@/app/(app)/flow.module.css';

/**
 * Yüklenmiş kanıt dosyası. `sha256` storage'daki nesneden okunmuştur (istemci beyanı değildir).
 * İmzalı indirme URL'i kısa ömürlüdür: tıklamada alınır, önbelleğe/loga yazılmaz.
 */
export function EvidenceCard({ doc }: { doc: EvidenceDocument }) {
  const api = useApi();
  // Mutasyon: URL cache'e girmez, her açışta yeni (audit'li) erişim üretilir.
  const open = useMutation({
    mutationFn: () => documentsApi(api).downloadUrl(doc.id),
    onSuccess: ({ url }) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  });
  return (
    <Card as="article">
      <div className={flow.between}>
        <Badge tone="trust">{DOCUMENT_TYPE_LABELS[doc.documentType] ?? doc.documentType}</Badge>
        {doc.uploadedAt ? (
          <span className={flow.small}>{formatDateTime(doc.uploadedAt)}</span>
        ) : null}
      </div>
      {doc.sha256 ? (
        <>
          <Overline>Bütünlük özeti (SHA-256)</Overline>
          <p className={flow.hash}>{doc.sha256}</p>
        </>
      ) : null}
      {open.error ? <ErrorState {...toDisplayError(open.error)} /> : null}
      <Button variant="secondary" loading={open.isPending} onClick={() => open.mutate()}>
        Görüntüle
      </Button>
    </Card>
  );
}
