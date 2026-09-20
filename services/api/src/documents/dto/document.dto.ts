import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { DOCUMENT_TYPES, type DocumentRecord, type DocumentType } from '../documents.service';

export class RegisterDocumentDto {
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @IsIn(DOCUMENT_TYPES)
  documentType!: DocumentType;

  /** İçerik tipi beyaz listeye karşı serviste de doğrulanır. */
  @IsString()
  contentType!: string;
}

export class ConfirmUploadDto {
  /**
   * İstemcinin hesapladığı özet — **isteğe bağlı** ve yalnızca karşılaştırma içindir.
   * Kaydedilen değer storage'dan okunandır (istemci beyanı kanıt değildir).
   */
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  sha256?: string;
}

export class DocumentResponseDto {
  id!: string;
  bookingId!: string | null;
  documentType!: string;
  contentType!: string;
  sizeBytes!: string | null;
  sha256!: string | null;
  status!: string;
  uploadedAt!: string | null;
  createdAt!: string;

  static from(document: DocumentRecord): DocumentResponseDto {
    return {
      id: document.id,
      bookingId: document.bookingId,
      documentType: document.documentType,
      contentType: document.contentType,
      sizeBytes: document.sizeBytes,
      sha256: document.sha256,
      status: document.status,
      uploadedAt: document.uploadedAt?.toISOString() ?? null,
      createdAt: document.createdAt.toISOString(),
    };
  }
}

export class RegisterDocumentResponseDto {
  document!: DocumentResponseDto;
  uploadUrl!: string;
  expiresAt!: string;
}

export class DocumentDownloadResponseDto {
  url!: string;
  expiresAt!: string;
}
