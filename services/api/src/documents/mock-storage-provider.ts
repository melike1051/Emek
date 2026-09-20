import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import {
  StorageError,
  type SignedDownloadUrl,
  type SignedUploadUrl,
  type StorageProvider,
} from './storage.port';

interface StoredObject {
  contentType: string;
  body: Buffer;
  sha256: string;
}

/**
 * Yerel geliştirme ve test için bellekte tutulan storage (ADR-0003).
 *
 * `STORAGE_PROVIDER=mock` production'da config seviyesinde reddedilir: bellekteki bir
 * kanıt deposu süreç yeniden başladığında silinir ve "dijital ispat" iddiasını taşımaz.
 *
 * Gerçek imzalı URL davranışının **üç** yönü burada da geçerlidir, çünkü bunlar olmadan
 * T-12 gerçeği ölçmez:
 * 1. URL imzalıdır ve imza yol + son kullanma + yöntem üzerinden hesaplanır.
 * 2. Süresi geçmiş URL reddedilir.
 * 3. İmzasız veya kurcalanmış URL reddedilir.
 */
@Injectable()
export class MockStorageProvider implements StorageProvider {
  readonly name = 'mock';

  private readonly objects = new Map<string, StoredObject>();

  constructor(private readonly config: AppConfigService) {}

  async createUploadUrl(input: {
    storageKey: string;
    contentType: string;
    maxBytes: number;
  }): Promise<SignedUploadUrl> {
    const expiresAt = this.expiry();
    const signature = this.sign('PUT', input.storageKey, expiresAt);

    return {
      url: this.buildUrl('PUT', input.storageKey, expiresAt, signature),
      headers: {
        'content-type': input.contentType,
        'x-max-bytes': String(input.maxBytes),
      },
      expiresAt,
    };
  }

  async createDownloadUrl(storageKey: string): Promise<SignedDownloadUrl> {
    const expiresAt = this.expiry();
    const signature = this.sign('GET', storageKey, expiresAt);

    return {
      url: this.buildUrl('GET', storageKey, expiresAt, signature),
      expiresAt,
    };
  }

  async statObject(storageKey: string): Promise<{ sha256: string; sizeBytes: number } | null> {
    const object = this.objects.get(storageKey);
    if (object === undefined) {
      return null;
    }
    return { sha256: object.sha256, sizeBytes: object.body.byteLength };
  }

  /**
   * Testlerin imzalı URL ile yükleme yapabilmesi için; gerçek sağlayıcıda karşılığı
   * storage servisinin kendisidir. İmza ve süre kontrolü burada da uygulanır.
   */
  putWithSignedUrl(url: string, contentType: string, body: Buffer): void {
    const parsed = this.parseAndVerify(url, 'PUT');

    if (body.byteLength > this.config.env.STORAGE_MAX_UPLOAD_BYTES) {
      throw new StorageError('OBJECT_TOO_LARGE', 'object exceeds maximum size');
    }

    this.objects.set(parsed.storageKey, {
      contentType,
      body,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  }

  /**
   * Boyut sınırını **uygulamadan** yazar.
   *
   * Gerçek GCS imzalı PUT'ta `x-max-bytes` gibi bir başlık boyutu kendiliğinden
   * sınırlamaz; bu metot o gerçeği taklit eder ve sunucu tarafındaki doğrulamanın
   * (confirmUpload) gerçekten çalıştığını ölçmeyi mümkün kılar (R-41).
   */
  forcePut(url: string, contentType: string, body: Buffer): void {
    const parsed = this.parseAndVerify(url, 'PUT');
    this.objects.set(parsed.storageKey, {
      contentType,
      body,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  }

  /** Testlerin imzalı URL ile okuma yapabilmesi için. */
  getWithSignedUrl(url: string): Buffer {
    const parsed = this.parseAndVerify(url, 'GET');
    const object = this.objects.get(parsed.storageKey);
    if (object === undefined) {
      throw new StorageError('NOT_FOUND', 'object not found');
    }
    return object.body;
  }

  private parseAndVerify(rawUrl: string, method: 'GET' | 'PUT'): { storageKey: string } {
    const url = new URL(rawUrl);
    const storageKey = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ''));
    const expires = url.searchParams.get('expires');
    const signature = url.searchParams.get('signature');
    const urlMethod = url.searchParams.get('method');

    if (expires === null || signature === null || urlMethod !== method) {
      throw new StorageError('INVALID_SIGNATURE', 'signed url is incomplete');
    }

    const expiresAt = new Date(Number(expires));
    if (Number.isNaN(expiresAt.getTime())) {
      throw new StorageError('INVALID_SIGNATURE', 'signed url expiry is invalid');
    }

    // Süre kontrolü imza kontrolünden önce: süresi geçmiş ama geçerli imzalı bir URL de
    // reddedilmelidir (T-12).
    if (expiresAt.getTime() <= Date.now()) {
      throw new StorageError('URL_EXPIRED', 'signed url has expired');
    }

    const expected = Buffer.from(this.sign(method, storageKey, expiresAt), 'utf8');
    const received = Buffer.from(signature, 'utf8');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new StorageError('INVALID_SIGNATURE', 'signed url signature mismatch');
    }

    return { storageKey };
  }

  private buildUrl(
    method: 'GET' | 'PUT',
    storageKey: string,
    expiresAt: Date,
    signature: string,
  ): string {
    const params = new URLSearchParams({
      method,
      expires: String(expiresAt.getTime()),
      signature,
    });
    return `https://storage.local/${this.config.env.STORAGE_BUCKET}/${encodeURIComponent(storageKey)}?${params.toString()}`;
  }

  private sign(method: string, storageKey: string, expiresAt: Date): string {
    return createHmac('sha256', this.config.env.STORAGE_SIGNING_SECRET)
      .update(`${method}:${this.config.env.STORAGE_BUCKET}:${storageKey}:${expiresAt.getTime()}`)
      .digest('hex');
  }

  private expiry(): Date {
    return new Date(Date.now() + this.config.env.STORAGE_SIGNED_URL_TTL_SECONDS * 1000);
  }
}
