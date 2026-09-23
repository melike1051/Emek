import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { AppConfigService } from '../common/config/app-config.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { EventType, OutboxService } from '../common/outbox/outbox.service';
import { StorageError, STORAGE_PROVIDER, type StorageProvider } from './storage.port';

export const DOCUMENT_TYPES = [
  'BEFORE_PHOTO',
  'AFTER_PHOTO',
  'SERVICE_NOTE',
  'DISPUTE_EVIDENCE',
  'INVOICE',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type DocumentStatus = 'PENDING_UPLOAD' | 'AVAILABLE' | 'DELETED';

/** Kabul edilen içerik tipleri — beyaz liste. Serbest içerik tipi, storage'ı rastgele dosya deposu yapardı. */
const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export interface DocumentRecord {
  id: string;
  bookingId: string | null;
  ownerUserId: string;
  documentType: DocumentType;
  contentType: string;
  sizeBytes: string | null;
  sha256: string | null;
  status: DocumentStatus;
  uploadedAt: Date | null;
  createdAt: Date;
}

interface DocumentRow {
  id: string;
  booking_id: string | null;
  owner_user_id: string;
  document_type: DocumentType;
  storage_key: string;
  content_type: string;
  size_bytes: string | null;
  sha256: string | null;
  status: DocumentStatus;
  uploaded_at: Date | null;
  created_at: Date;
}

function toRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    bookingId: row.booking_id,
    ownerUserId: row.owner_user_id,
    documentType: row.document_type,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    status: row.status,
    uploadedAt: row.uploaded_at,
    createdAt: row.created_at,
    // `storage_key` istemciye **verilmez**: bucket içi yol iç bir detaydır ve
    // tahmin yüzeyi açar. Erişim yalnızca imzalı URL ile olur.
  };
}

const SELECT_DOCUMENT = `
  SELECT id, booking_id, owner_user_id, document_type, storage_key, content_type,
         size_bytes, sha256, status, uploaded_at, created_at
    FROM documents
`;

/**
 * Dijital ispat dokümanları.
 *
 * Akış üç adımdır ve bu bilinçli bir seçimdir:
 * 1. `register` — metadata yazılır, imzalı **yükleme** URL'i döner.
 * 2. İstemci dosyayı doğrudan storage'a yükler (API'den geçmez).
 * 3. `confirmUpload` — storage'daki nesnenin **gerçek** özeti okunur ve kaydedilir.
 *
 * Üçüncü adım olmadan `sha256` istemcinin beyanı olurdu; kanıt değeri taşımazdı.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * `statObject`'in boyut sınırını aşan nesne için ürettiği `OBJECT_TOO_LARGE`,
   * istemcinin gördüğü aynı doğrulama hatasına çevrilir.
   *
   * Adapter sınırı aşan nesneyi **okumadan** reddeder (indirip hash'lemek, yükleme
   * sınırını bant genişliği saldırısına çevirirdi); ama bu istemci açısından hâlâ
   * "dosya çok büyük"tür, 500 değil.
   */
  private async statOrTooLarge(
    storageKey: string,
  ): Promise<{ sha256: string; sizeBytes: number } | null> {
    try {
      return await this.storage.statObject(storageKey);
    } catch (error: unknown) {
      if (error instanceof StorageError && error.code === 'OBJECT_TOO_LARGE') {
        throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
          clientMessage: 'Dosya boyutu sınırı aşıyor.',
          details: { maxBytes: this.config.env.STORAGE_MAX_UPLOAD_BYTES },
        });
      }
      throw error;
    }
  }

  async register(input: {
    userId: string;
    bookingId?: string;
    documentType: DocumentType;
    contentType: string;
  }): Promise<{ document: DocumentRecord; uploadUrl: string; expiresAt: Date }> {
    if (!ALLOWED_CONTENT_TYPES.includes(input.contentType)) {
      throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Bu dosya türü desteklenmiyor.',
        details: { allowed: ALLOWED_CONTENT_TYPES },
      });
    }

    if (input.bookingId !== undefined) {
      await this.assertBookingParticipant(input.bookingId, input.userId);
    } else if (input.documentType !== 'INVOICE') {
      throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Bu doküman türü bir rezervasyona bağlı olmalı.',
      });
    }

    // Anahtar tahmin edilemez: bucket içi yol sıralı/öngörülebilir olsaydı, imza
    // doğrulaması olmasa da nesneler taranabilir olurdu (savunma katmanı).
    const storageKey = `documents/${input.bookingId ?? 'general'}/${randomUUID()}`;

    const upload = await this.storage.createUploadUrl({
      storageKey,
      contentType: input.contentType,
      maxBytes: this.config.env.STORAGE_MAX_UPLOAD_BYTES,
    });

    const document = await this.uow.withTransaction(async (client) => {
      const result = await client.query<DocumentRow>(
        `INSERT INTO documents (booking_id, owner_user_id, document_type, storage_key, content_type)
         VALUES ($1, $2, $3::document_type, $4, $5)
         RETURNING id, booking_id, owner_user_id, document_type, storage_key, content_type,
                   size_bytes, sha256, status, uploaded_at, created_at`,
        [input.bookingId ?? null, input.userId, input.documentType, storageKey, input.contentType],
      );

      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('doküman kaydı oluşturulamadı');
      }

      await this.audit.record(client, {
        action: AuditAction.DOCUMENT_REGISTERED,
        entityType: 'document',
        entityId: row.id,
        actorUserId: input.userId,
        newValue: { documentType: input.documentType, bookingId: input.bookingId ?? null },
      });

      return toRecord(row);
    });

    return { document, uploadUrl: upload.url, expiresAt: upload.expiresAt };
  }

  /**
   * Yüklemeyi doğrular: storage'daki nesnenin özeti okunur ve kaydedilir.
   *
   * İstemci bir `sha256` bildirirse **karşılaştırılır** ama kaydedilen storage'dan
   * okunan değerdir: uyuşmazlık, istemcinin farklı bir dosya yüklediğini gösterir.
   */
  async confirmUpload(input: {
    documentId: string;
    userId: string;
    expectedSha256?: string;
  }): Promise<DocumentRecord> {
    return this.uow.withTransaction(async (client) => {
      const existing = await client.query<DocumentRow>(
        `${SELECT_DOCUMENT} WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [input.documentId, input.userId],
      );

      const row = existing.rows[0];
      if (row === undefined) {
        throw new BusinessException(ErrorCode.DOCUMENT_NOT_FOUND);
      }
      if (row.status === 'AVAILABLE') {
        // Idempotent değil, bilinçli olarak reddedilir: ikinci onay farklı bir dosyanın
        // geçirilmeye çalışıldığı anlamına gelebilir ve sha256 zaten değiştirilemez.
        throw new BusinessException(ErrorCode.DOCUMENT_ALREADY_UPLOADED);
      }

      const stat = await this.statOrTooLarge(row.storage_key);
      if (stat === null) {
        throw new BusinessException(ErrorCode.DOCUMENT_NOT_FOUND, {
          clientMessage: 'Dosya storage.da bulunamadı, yükleme tamamlanmamış olabilir.',
        });
      }

      if (input.expectedSha256 !== undefined && input.expectedSha256 !== stat.sha256) {
        throw new BusinessException(ErrorCode.DOCUMENT_INTEGRITY_MISMATCH);
      }

      // Boyut sınırı **yükleme sonrası da** doğrulanır (Faz 5 review bulgusu H2).
      // İmzalı URL'e eklenen `x-max-bytes` başlığı bir niyet beyanıdır: gerçek GCS
      // imzalı PUT'ta keyfi bir başlık boyut sınırı uygulamaz. Sunucu tarafındaki bu
      // kontrol olmadan sınır, storage adapter'ı değiştiğinde sessizce buharlaşırdı.
      // GCS adapter'ı sınırı aşan nesneyi hiç okumaz (`OBJECT_TOO_LARGE`) — aşağıdaki
      // kontrol yine de kalır: sınır tek bir adapter'ın davranışına bağlı olmamalı (R-41).
      if (stat.sizeBytes > this.config.env.STORAGE_MAX_UPLOAD_BYTES) {
        throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
          clientMessage: 'Dosya boyutu sınırı aşıyor.',
          details: { maxBytes: this.config.env.STORAGE_MAX_UPLOAD_BYTES },
        });
      }

      const updated = await client.query<DocumentRow>(
        `UPDATE documents
            SET status = 'AVAILABLE', sha256 = $2, size_bytes = $3, uploaded_at = now()
          WHERE id = $1
          RETURNING id, booking_id, owner_user_id, document_type, storage_key, content_type,
                    size_bytes, sha256, status, uploaded_at, created_at`,
        [row.id, stat.sha256, String(stat.sizeBytes)],
      );

      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) {
        throw new Error('doküman güncellenemedi');
      }

      await this.audit.record(client, {
        action: AuditAction.DOCUMENT_UPLOAD_CONFIRMED,
        entityType: 'document',
        entityId: row.id,
        actorUserId: input.userId,
        // Hash audit'e yazılır: kanıt zincirinin denetlenebilir olması için gerekir.
        newValue: { sha256: stat.sha256, sizeBytes: stat.sizeBytes },
      });

      if (updatedRow.booking_id !== null) {
        await this.outbox.enqueue(client, {
          eventType: EventType.SERVICE_EVIDENCE_ADDED,
          subjectType: 'booking',
          subjectId: updatedRow.booking_id,
          payload: {
            bookingId: updatedRow.booking_id,
            documentId: updatedRow.id,
            documentType: updatedRow.document_type,
          },
        });
      }

      return toRecord(updatedRow);
    });
  }

  /**
   * İndirme için kısa ömürlü imzalı URL üretir.
   *
   * Erişim rezervasyonun **taraflarına** açıktır: kanıt fotoğrafı müşterinin evinin
   * içini gösterir, bu yüzden üçüncü kişiye (ve rastgele bir sağlayıcıya) açılmaz.
   * Her erişim audit'lenir.
   */
  async createDownloadUrl(input: {
    documentId: string;
    userId: string;
    roles: string[];
  }): Promise<{ url: string; expiresAt: Date }> {
    const isAdmin = input.roles.includes('ADMIN');

    const rows = await this.uow.query<DocumentRow>(
      `SELECT d.id, d.booking_id, d.owner_user_id, d.document_type, d.storage_key,
              d.content_type, d.size_bytes, d.sha256, d.status, d.uploaded_at, d.created_at
         FROM documents d
         LEFT JOIN bookings b ON b.id = d.booking_id
        WHERE d.id = $1
          AND ($3::boolean
               OR d.owner_user_id = $2
               OR b.customer_id = $2
               OR b.provider_id = $2)`,
      [input.documentId, input.userId, isAdmin],
    );

    const row = rows[0];
    if (row === undefined || row.status !== 'AVAILABLE') {
      throw new BusinessException(ErrorCode.DOCUMENT_NOT_FOUND);
    }

    const signed = await this.storage.createDownloadUrl(row.storage_key);

    await this.uow.withTransaction((client) =>
      this.audit.record(client, {
        action: AuditAction.DOCUMENT_ACCESS_GRANTED,
        entityType: 'document',
        entityId: row.id,
        actorUserId: input.userId,
        newValue: { expiresAt: signed.expiresAt.toISOString() },
      }),
    );

    return { url: signed.url, expiresAt: signed.expiresAt };
  }

  /** Rezervasyona bağlı kanıt dokümanları — yalnızca taraflar görür. */
  async listForBooking(bookingId: string, userId: string): Promise<DocumentRecord[]> {
    await this.assertBookingParticipant(bookingId, userId);

    const rows = await this.uow.query<DocumentRow>(
      `${SELECT_DOCUMENT} WHERE booking_id = $1 AND status = 'AVAILABLE' ORDER BY created_at`,
      [bookingId],
    );
    return rows.map(toRecord);
  }

  private async assertBookingParticipant(bookingId: string, userId: string): Promise<void> {
    const rows = await this.uow.query<{ id: string }>(
      `SELECT id FROM bookings
        WHERE id = $1 AND (customer_id = $2 OR provider_id = $2)`,
      [bookingId, userId],
    );
    if (rows.length === 0) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }
  }
}
