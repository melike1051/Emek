import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Storage } from '@google-cloud/storage';
import type { Bucket } from '@google-cloud/storage';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import {
  StorageError,
  type SignedDownloadUrl,
  type SignedUploadUrl,
  type StorageProvider,
} from './storage.port';

/**
 * Google Cloud Storage adapter'ı (Faz 13, R-41).
 *
 * Bucket'ın private olması, uniform bucket-level access ve public access prevention
 * **altyapı kararıdır** ve Terraform'da zorunlu kılınır (`infra/terraform/modules/storage`).
 * Uygulama bunu "umut etmez" ama doğrulayabilir: `assertPrivate()` başlangıçta bucket
 * yapılandırmasını okur ve yanlışsa servisin kanıt yazmasına izin vermez.
 *
 * İmzalama **anahtar dosyasıyla değil**, IAM `signBlob` ile yapılır: uzun ömürlü bir
 * servis hesabı JSON anahtarı üretilmez (ADR-0023). İmzalayan kimlik, çalışma zamanının
 * kendi kimliğidir (Cloud Run servis hesabı, ADC üzerinden); `getSignedUrl` özel anahtar
 * bulamadığında IAM `signBlob`'a düşer. Bunun için servis hesabının **kendi üzerinde**
 * `roles/iam.serviceAccountTokenCreator` rolü olmalıdır (Terraform'da tanımlı).
 *
 * İmzalayanı ayrıca yapılandıran bir ayar bilinçli olarak **yoktur**: `getSignedUrl`
 * böyle bir seçenek almaz ve almış gibi davranan bir ayar, çalışmadığı hâlde
 * "yapılandırıldı" izlenimi verirdi.
 */
@Injectable()
export class GcsStorageProvider implements StorageProvider, OnApplicationBootstrap {
  readonly name = 'gcs';

  constructor(
    private readonly bucket: Bucket,
    private readonly config: AppConfigService,
  ) {}

  static create(config: AppConfigService): GcsStorageProvider {
    const storage = new Storage({ projectId: config.env.GCP_PROJECT_ID });
    return new GcsStorageProvider(storage.bucket(config.env.STORAGE_BUCKET), config);
  }

  /**
   * Bucket yapılandırması **başlatmada** doğrulanır.
   *
   * Yanlış yapılandırılmış bir bucket ile ayağa kalkmak, ilk kanıt fotoğrafı
   * yüklendikten sonra fark edilecek bir ifşa demektir. Burada boot başarısız olur;
   * Cloud Run yeni revizyona trafik vermez ve önceki revizyon hizmet vermeye devam eder.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.assertPrivate();
  }

  async createUploadUrl(input: {
    storageKey: string;
    contentType: string;
    maxBytes: number;
  }): Promise<SignedUploadUrl> {
    const expiresAt = this.expiry();

    // `contentType` imzaya dahildir: istemci başka bir tip yükleyemez.
    const [url] = await this.bucket.file(input.storageKey).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: expiresAt,
      contentType: input.contentType,
    });

    return {
      url,
      headers: {
        'content-type': input.contentType,
        // Bilgi amaçlıdır; GCS bunu **uygulamaz**. Gerçek sınır `confirmUpload`'daki
        // sunucu tarafı kontrolüdür (Faz 5 review bulgusu H2).
        'x-max-bytes': String(input.maxBytes),
      },
      expiresAt,
    };
  }

  async createDownloadUrl(storageKey: string): Promise<SignedDownloadUrl> {
    const expiresAt = this.expiry();

    const [url] = await this.bucket.file(storageKey).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expiresAt,
    });

    return { url, expiresAt };
  }

  /**
   * Nesnenin gerçek özeti ve boyutu.
   *
   * GCS `md5Hash`/`crc32c` tutar, sha256 tutmaz — bu yüzden özet nesne okunarak
   * hesaplanır. Önce **boyut** okunur: sınırı aşan bir nesneyi hash'lemek için
   * indirmek, yükleme sınırını bellek/bant genişliği saldırısına çevirirdi.
   */
  async statObject(storageKey: string): Promise<{ sha256: string; sizeBytes: number } | null> {
    const file = this.bucket.file(storageKey);

    let sizeBytes: number;
    try {
      const [metadata] = await file.getMetadata();
      sizeBytes = Number(metadata.size ?? 0);
    } catch (error: unknown) {
      if ((error as { code?: number }).code === 404) {
        return null;
      }
      throw error;
    }

    const maxBytes = this.config.env.STORAGE_MAX_UPLOAD_BYTES;
    if (sizeBytes > maxBytes) {
      throw new StorageError(
        'OBJECT_TOO_LARGE',
        `object exceeds maximum size (${sizeBytes} > ${maxBytes})`,
      );
    }

    const digest = createHash('sha256');
    await pipeline(file.createReadStream(), digest);

    return { sha256: digest.digest('hex'), sizeBytes };
  }

  /**
   * Bucket'ın gerçekten private olduğunu doğrular (R-41).
   *
   * Yanlış yapılandırılmış bir bucket'ta imzalı URL modeli anlamını yitirir: nesneler
   * imza olmadan da okunabilir. Burada **başlatmada** bakılır; ilk müşteri fotoğrafı
   * yüklendikten sonra fark etmek geç olurdu.
   */
  async assertPrivate(): Promise<void> {
    const [metadata] = await this.bucket.getMetadata();

    const uniformAccess = metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled === true;
    const publicPrevention = metadata.iamConfiguration?.publicAccessPrevention === 'enforced';

    if (!uniformAccess || !publicPrevention) {
      throw new StorageError(
        'BUCKET_NOT_PRIVATE',
        `storage bucket ${this.bucket.name} güvenli değil ` +
          `(uniformBucketLevelAccess=${String(uniformAccess)}, ` +
          `publicAccessPrevention=${String(publicPrevention)}) — R-41`,
      );
    }
  }

  private expiry(): Date {
    return new Date(Date.now() + this.config.env.STORAGE_SIGNED_URL_TTL_SECONDS * 1000);
  }
}
