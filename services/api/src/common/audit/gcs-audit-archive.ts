import { Storage } from '@google-cloud/storage';
import type { Bucket } from '@google-cloud/storage';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { AppConfigService } from '../config/app-config.service';
import { AuditArchiveError, type AuditArchive } from './audit-archive.port';

/**
 * Retention-locked audit arşivi — Google Cloud Storage (Faz 13, R-82).
 *
 * Değişmezlik **altyapıdan** gelir, uygulamadan değil:
 *
 * 1. **Bucket retention policy (kilitli).** Terraform bucket'ı `retention_policy`
 *    + `is_locked = true` ile oluşturur. Kilitli politika proje sahibi tarafından
 *    bile gevşetilemez veya kaldırılamaz ve **her** nesneye otomatik uygulanır:
 *    nesne, oluşturulmasından itibaren süre dolmadan silinemez veya üzerine yazılamaz.
 * 2. **IAM.** Servis hesabının rolü `roles/storage.objectCreator`'dır: yalnızca
 *    yazabilir. Silme, güncelleme ve saklama süresi değiştirme izni **yoktur**.
 *
 * Bu yüzden uygulama nesne bazlı saklama süresi **yazmaz** — yazamaz da: `setRetention`
 * izni bilinçli olarak verilmemiştir ve vermek, arşivi değiştirme yolunu açardı.
 * Bunun yerine, port'un istediği `retentionUntil` bucket'ın gerçekten garanti ettiği
 * süreyle **karşılaştırılır**; bucket daha kısa garanti veriyorsa yazma reddedilir.
 * Altyapının veremediği bir garantiyi sessizce vermiş gibi davranmak, arşivin
 * kendisini kâğıt üzerinde bırakırdı.
 */
@Injectable()
export class GcsAuditArchive implements AuditArchive, OnApplicationBootstrap {
  readonly name = 'gcs';

  /** Bucket'ın kilitli politikayla garanti ettiği saklama süresi (saniye). */
  private guaranteedRetentionSeconds?: number;

  constructor(private readonly bucket: Bucket) {}

  static create(config: AppConfigService): GcsAuditArchive {
    const bucketName = config.env.AUDIT_ARCHIVE_BUCKET;
    if (bucketName === undefined) {
      throw new Error('AUDIT_ARCHIVE_PROVIDER=gcs iken AUDIT_ARCHIVE_BUCKET zorunludur');
    }
    const storage = new Storage({ projectId: config.env.GCP_PROJECT_ID });
    return new GcsAuditArchive(storage.bucket(bucketName));
  }

  /**
   * Arşivin gerçekten değişmez olduğunu **başlatmada** doğrular (R-82).
   *
   * Kilitli olmayan bir retention policy sahibi tarafından kaldırılabilir; o durumda
   * "veritabanından bağımsız, değiştirilemez kopya" iddiası taşınamaz ve servis o
   * iddiayla ayağa kalkmamalıdır.
   */
  async onApplicationBootstrap(): Promise<void> {
    const [metadata] = await this.bucket.getMetadata();

    const policy = metadata.retentionPolicy;
    if (policy?.isLocked !== true) {
      throw new AuditArchiveError(
        `audit arşiv bucket'ı ${this.bucket.name} kilitli retention policy taşımıyor — ` +
          'kilitsiz politika kaldırılabilir, yani arşiv değişmez değildir (R-82)',
      );
    }

    if (metadata.iamConfiguration?.publicAccessPrevention !== 'enforced') {
      throw new AuditArchiveError(
        `audit arşiv bucket'ı ${this.bucket.name} public erişime kapalı değil`,
      );
    }

    const period = Number(policy.retentionPeriod ?? 0);
    if (!Number.isFinite(period) || period <= 0) {
      throw new AuditArchiveError(
        `audit arşiv bucket'ı ${this.bucket.name} geçerli bir saklama süresi bildirmiyor`,
      );
    }

    this.guaranteedRetentionSeconds = period;
  }

  async put(input: { storageKey: string; body: string; retentionUntil: Date }): Promise<void> {
    if (this.guaranteedRetentionSeconds === undefined) {
      throw new AuditArchiveError(
        'audit arşivi doğrulanmadan kullanılamaz (bucket retention policy okunmadı)',
      );
    }

    // İstenen süre bucket'ın garantisini aşıyorsa yazma reddedilir: nesne yazılıp
    // "10 yıl saklanıyor" denseydi, bucket 30 gün sonra silinmesine izin verirdi.
    const requestedSeconds = (input.retentionUntil.getTime() - Date.now()) / 1000;
    if (requestedSeconds > this.guaranteedRetentionSeconds) {
      throw new AuditArchiveError(
        `istenen saklama süresi (${Math.round(requestedSeconds)}s) bucket'ın garantisini ` +
          `(${this.guaranteedRetentionSeconds}s) aşıyor — AUDIT_EXPORT_RETENTION_DAYS ile ` +
          "bucket'ın kilitli retention policy'si uyuşmuyor (R-82)",
      );
    }

    try {
      await this.bucket.file(input.storageKey).save(input.body, {
        contentType: 'application/json',
        // Üzerine yazma yok: nesne yoksa yazılır, varsa 412 döner. Kilitli
        // politika zaten reddederdi; bu, hatanın net görünmesini sağlar.
        preconditionOpts: { ifGenerationMatch: 0 },
        resumable: false,
      });
    } catch (error: unknown) {
      if ((error as { code?: number }).code === 412) {
        throw new AuditArchiveError(`arşiv nesnesi zaten var: ${input.storageKey}`);
      }
      throw new AuditArchiveError(
        `audit arşiv yazımı başarısız (${input.storageKey}): ${String(error)}`,
      );
    }
  }
}
