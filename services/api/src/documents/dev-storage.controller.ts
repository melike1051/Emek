import { Controller, Get, HttpCode, HttpStatus, Put, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/auth.decorators';
import { SkipAppCheck } from '../common/appcheck/app-check.decorators';
import { AppConfigService } from '../common/config/app-config.service';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { ALLOWED_CONTENT_TYPES } from './documents.service';
import { MockStorageProvider } from './mock-storage-provider';
import { StorageError } from './storage.port';

/**
 * Mock storage'ın yerel HTTP yüzeyi — gerçek GCS'nin imzalı PUT/GET uçlarının yerini tutar
 * ki web istemcisi yükleme akışını (register → PUT → confirm) yerelde uçtan uca koşabilsin.
 *
 * Yalnızca `STORAGE_PROVIDER=mock` iken yanıt verir; aksi hâlde 404. Config, mock'u
 * dağıtılan ortamlarda (staging/production) zaten reddeder — bu uç orada hiç çalışamaz.
 *
 * Kimlik doğrulaması **imzadır** (GCS ile aynı model): `@Public`, çünkü tarayıcı imzalı
 * URL'e Authorization başlığı eklemez; imza, süre ve yöntem `MockStorageProvider`'da
 * doğrulanır. İstemci uygulaması değil storage taklidi olduğundan App Check uygulanmaz.
 *
 * Genel API sözleşmesinin (OpenAPI) parçası değildir: istemciler bu yolu kurmaz, imzalı URL'i
 * olduğu gibi kullanır — bulutta aynı URL GCS'yi gösterir.
 */
@ApiExcludeController()
@Controller('_dev/storage')
@Public()
@SkipAppCheck()
@RateLimit({ name: 'dev-storage', limit: 120, windowSeconds: 60 })
export class DevStorageController {
  constructor(
    private readonly config: AppConfigService,
    private readonly storage: MockStorageProvider,
  ) {}

  @Put(':bucket/:key')
  @HttpCode(HttpStatus.OK)
  async put(@Req() request: Request): Promise<void> {
    this.assertMockStorage();
    // GCS içerik tipini imzaya bağlar; mock bilemez. Beyaz liste dışı tip reddedilir: bu uç
    // web ile **aynı origin**'den sunulur ve `text/html` gibi bir tip saklı XSS olurdu.
    const contentType = request.headers['content-type'] ?? '';
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Bu dosya türü yüklenemez.',
        details: { allowed: ALLOWED_CONTENT_TYPES },
      });
    }
    const maxBytes = this.config.env.STORAGE_MAX_UPLOAD_BYTES;
    const body = await readBody(request, maxBytes);
    try {
      this.storage.putWithSignedUrl(request.originalUrl, contentType, body);
    } catch (error) {
      throw toHttpError(error);
    }
  }

  @Get(':bucket/:key')
  get(@Req() request: Request, @Res() response: Response): void {
    this.assertMockStorage();
    let object: { body: Buffer; contentType: string };
    try {
      object = this.storage.readWithSignedUrl(request.originalUrl);
    } catch (error) {
      throw toHttpError(error);
    }
    response
      .status(HttpStatus.OK)
      .setHeader('Content-Type', object.contentType)
      // Kanıt dosyası: tarayıcı ve ara katmanlar saklamaz (imzalı URL cache'lenmez).
      .setHeader('Cache-Control', 'no-store')
      .setHeader('X-Content-Type-Options', 'nosniff')
      // Aynı-origin'den sunulan kullanıcı dosyası: betik çalıştıramaz, sayfaya gömülemez.
      .setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox")
      .send(object.body);
  }

  private assertMockStorage(): void {
    if (this.config.env.STORAGE_PROVIDER !== 'mock') {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }
  }
}

/**
 * Gövdeyi sınırla okur: sınırı aşan istek belleği doldurmadan kesilir. JSON olmayan içerik
 * tiplerini global gövde ayrıştırıcıları tüketmez; akış burada okunmamış hâldedir.
 */
async function readBody(request: Request, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Dosya boyutu sınırı aşıyor.',
        details: { maxBytes },
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function toHttpError(error: unknown): unknown {
  if (!(error instanceof StorageError)) return error;
  switch (error.code) {
    case 'NOT_FOUND':
      return new BusinessException(ErrorCode.DOCUMENT_NOT_FOUND);
    case 'OBJECT_TOO_LARGE':
      return new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Dosya boyutu sınırı aşıyor.',
      });
    default:
      // İmza/süre hatası: ayrıntı verilmez (hangi kısmın geçersiz olduğu sızmaz).
      return new BusinessException(ErrorCode.FORBIDDEN);
  }
}
