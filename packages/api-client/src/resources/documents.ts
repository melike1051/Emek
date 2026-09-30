import { pathSegment, type ApiClient } from '../client';
import { ApiError, CLIENT_ERROR_CODES } from '../errors';

/** Kaynak: services/api/src/documents/documents.service.ts (DOCUMENT_TYPES). */
export type DocumentType =
  'BEFORE_PHOTO' | 'AFTER_PHOTO' | 'SERVICE_NOTE' | 'DISPUTE_EVIDENCE' | 'INVOICE';

/** Kaynak: services/api/src/documents/dto (DocumentResponseDto). `sha256` storage'dan okunur. */
export interface EvidenceDocument {
  id: string;
  bookingId: string | null;
  documentType: DocumentType;
  contentType: string;
  sizeBytes: string | null;
  sha256: string | null;
  status: string;
  uploadedAt: string | null;
  createdAt: string;
}

/** Kaynak: DocumentDownloadResponseDto — kısa ömürlü imzalı URL; cache'lenmez, loglanmaz. */
export interface DocumentDownload {
  url: string;
  expiresAt: string;
}

/** Kaynak: RegisterDocumentResponseDto — `uploadUrl` imzalıdır, kısa ömürlüdür, loglanmaz. */
export interface DocumentRegistration {
  document: EvidenceDocument;
  uploadUrl: string;
  expiresAt: string;
}

/** Kaynak: documents.service.ts (ALLOWED_CONTENT_TYPES) — backend ayrıca doğrular. */
export const EVIDENCE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

/** Varsayılan `STORAGE_MAX_UPLOAD_BYTES` (10 MiB). Ön kontroldür; sınırı backend uygular. */
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;

export function documentsApi(client: ApiClient) {
  return {
    register: (input: { bookingId: string; documentType: DocumentType; contentType: string }) =>
      client.post<DocumentRegistration>('/documents', input),
    /**
     * `sha256` yalnızca karşılaştırma içindir: kaydedilen özet storage'daki nesneden okunur
     * (istemci beyanı kanıt değildir). Uyuşmazlık `DOCUMENT_INTEGRITY_MISMATCH` döner.
     */
    confirm: (documentId: string, sha256: string) =>
      client.post<EvidenceDocument>(`/documents/${pathSegment(documentId)}/confirm`, { sha256 }),
    listForBooking: (bookingId: string) =>
      client.get<EvidenceDocument[]>(`/bookings/${pathSegment(bookingId)}/documents`),
    downloadUrl: (documentId: string) =>
      client.get<DocumentDownload>(`/documents/${pathSegment(documentId)}/download-url`),
  };
}

/**
 * Dosyayı imzalı URL'e **doğrudan** yükler (dosya API'den geçmez). Bu istek Emek API'sine
 * gitmediği için kimlik/App Check başlığı **taşımaz** — imza yetkidir. Yalnızca imzada
 * sabitlenen `Content-Type` gönderilir.
 */
export async function putToSignedUrl(
  uploadUrl: string,
  file: Blob,
  contentType: string,
  doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<void> {
  let response: Response;
  try {
    response = await doFetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: file,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw ApiError.client(CLIENT_ERROR_CODES.NETWORK);
  }
  if (!response.ok) {
    throw ApiError.client(CLIENT_ERROR_CODES.UPLOAD_FAILED, response.status);
  }
}

/** Dosyanın SHA-256 özeti (hex) — confirm'de storage'daki özetle karşılaştırılır. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
