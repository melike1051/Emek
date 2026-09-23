import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.decorators';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { UserRateLimit } from '../common/ratelimit/user-rate-limit.decorator';
import { DocumentsService } from './documents.service';
import {
  ConfirmUploadDto,
  DocumentDownloadResponseDto,
  DocumentResponseDto,
  RegisterDocumentDto,
  RegisterDocumentResponseDto,
} from './dto/document.dto';

@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /**
   * Doküman kaydı + imzalı yükleme URL'i.
   *
   * Dosya içeriği API'den geçmez: istemci doğrudan storage'a yükler ve sonra
   * `confirm` çağırır. Bütünlük storage'daki nesnenin özetinden doğrulanır.
   */
  @Post('documents')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'document-register', limit: 60, windowSeconds: 60 })
  @UserRateLimit({ name: 'document-register', limit: 60, windowSeconds: 300 })
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDocumentDto,
  ): Promise<RegisterDocumentResponseDto> {
    const result = await this.documents.register({
      userId: user.id,
      ...(dto.bookingId !== undefined ? { bookingId: dto.bookingId } : {}),
      documentType: dto.documentType,
      contentType: dto.contentType,
    });

    return {
      document: DocumentResponseDto.from(result.document),
      uploadUrl: result.uploadUrl,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  @Post('documents/:id/confirm')
  async confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmUploadDto,
  ): Promise<DocumentResponseDto> {
    const document = await this.documents.confirmUpload({
      documentId: id,
      userId: user.id,
      ...(dto.sha256 !== undefined ? { expectedSha256: dto.sha256 } : {}),
    });
    return DocumentResponseDto.from(document);
  }

  /** Kısa ömürlü indirme URL'i. Her erişim audit'lenir. */
  @Get('documents/:id/download-url')
  @RateLimit({ name: 'document-download', limit: 120, windowSeconds: 60 })
  // İmzalı URL üretimi kanıt dosyalarına erişimdir: numaralandırma denemeleri
  // hesap başına sınırlanır ve her erişim zaten audit'lenir.
  @UserRateLimit({ name: 'document-download', limit: 60, windowSeconds: 300 })
  async downloadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentDownloadResponseDto> {
    const signed = await this.documents.createDownloadUrl({
      documentId: id,
      userId: user.id,
      roles: user.roles,
    });
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  @Get('bookings/:id/documents')
  async listForBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentResponseDto[]> {
    const documents = await this.documents.listForBooking(id, user.id);
    return documents.map(DocumentResponseDto.from);
  }
}
