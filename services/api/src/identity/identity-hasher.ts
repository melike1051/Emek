import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';

/**
 * Kimlik hash'i üretimi (ADR-0004 §4-5).
 *
 * - Algoritma **HMAC-SHA256**'dır. Düz `SHA256(TCKN)` yasaktır: 11 haneli giriş uzayı
 *   saniyeler içinde brute-force edilebilir, yani hash kimlik numarasını korumaz.
 * - Anahtar **Cloud KMS**'te non-exportable olarak durur ve **rotasyona tabi değildir**:
 *   ham girdi bilinçli olarak saklanmadığı için mevcut hash'ler yeniden hesaplanamaz,
 *   anahtar değişirse aynı kişi farklı hash üretir ve tekillik sessizce bozulur.
 * - `hash_key_version` teşhis içindir (hangi kayıt hangi anahtarla üretildi), rotasyon için değil.
 *
 * Anahtar kaynağı porttur: yerelde ortam değişkeni, production'da KMS. Production'da
 * ortam değişkeni kaynağı **config seviyesinde reddedilir** (env.schema).
 */

export interface IdentityHashKeyProvider {
  readonly version: string;
  key(): Promise<Buffer>;
}

export const IDENTITY_HASH_KEY_PROVIDER = Symbol('IDENTITY_HASH_KEY_PROVIDER');

/** Yerel geliştirme ve test: anahtar ortam değişkeninden gelir. */
@Injectable()
export class EnvIdentityHashKeyProvider implements IdentityHashKeyProvider {
  readonly version: string;
  private readonly material: Buffer;

  constructor(@Inject(AppConfigService) config: AppConfigService) {
    this.material = Buffer.from(config.env.IDENTITY_HASH_KEY, 'utf8');
    this.version = `env:${config.env.IDENTITY_HASH_KEY_VERSION}`;
  }

  async key(): Promise<Buffer> {
    return this.material;
  }
}

/**
 * Production anahtar kaynağı. Cloud KMS entegrasyonu Faz 13'te (Terraform ile anahtar
 * sağlandığında) yazılacak. Şimdilik açıkça başarısız olur — sessizce zayıf bir anahtara
 * düşmek, tekillik kontrolünü kâğıt üzerinde bırakırdı.
 *
 * TODO(faz-13): Cloud KMS MAC anahtarı ile imzalama.
 */
@Injectable()
export class KmsIdentityHashKeyProvider implements IdentityHashKeyProvider {
  readonly version = 'kms:not-implemented';

  async key(): Promise<Buffer> {
    throw new Error(
      'Cloud KMS identity hash anahtarı henüz bağlanmadı (Faz 13). ' +
        'Production yapılandırması IDENTITY_HASH_KEY_SOURCE=kms ile başlatılamaz.',
    );
  }
}

@Injectable()
export class IdentityHasher {
  constructor(
    @Inject(IDENTITY_HASH_KEY_PROVIDER) private readonly keyProvider: IdentityHashKeyProvider,
  ) {}

  get keyVersion(): string {
    return this.keyProvider.version;
  }

  /**
   * Normalize edilmiş kimlik referansından deterministik hash üretir.
   *
   * Normalizasyon önemlidir: boşluk/biçim farkı aynı kişi için farklı hash üretirse
   * tekillik kontrolü atlanabilir.
   */
  async hash(rawIdentityReference: string): Promise<string> {
    const normalized = rawIdentityReference.trim().toUpperCase().replace(/\s+/g, '');

    if (normalized.length === 0) {
      throw new Error('kimlik referansı boş olamaz');
    }

    const key = await this.keyProvider.key();
    return createHmac('sha256', key).update(normalized, 'utf8').digest('hex');
  }

  /** Sabit zamanlı karşılaştırma: hash eşleşmesi zamanlama sızdırmamalı. */
  equals(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
