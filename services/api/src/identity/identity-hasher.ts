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
 * **Port HMAC'in kendisidir, anahtar değil** (Faz 13, R-39). Önceki tasarım anahtar
 * materyalini uygulamaya döndürüyordu; Cloud KMS MAC anahtarı non-exportable'dır ve
 * zaten döndürülemez. Daha önemlisi: anahtarı süreç belleğine getirmek, KMS'i bir
 * "secret store"a indirger — heap dump veya log, anahtarı sızdırır. Bu arayüzde
 * uygulama yalnızca **mesajı** verir, MAC'i KMS hesaplar.
 */

export interface IdentityMacProvider {
  readonly version: string;
  /** Normalize edilmiş mesajın HMAC-SHA256 etiketini üretir. */
  mac(message: Buffer): Promise<Buffer>;
}

export const IDENTITY_MAC_PROVIDER = Symbol('IDENTITY_MAC_PROVIDER');

/** Yerel geliştirme ve test: anahtar ortam değişkeninden gelir, HMAC süreç içinde hesaplanır. */
@Injectable()
export class EnvIdentityMacProvider implements IdentityMacProvider {
  readonly version: string;
  private readonly material: Buffer;

  constructor(@Inject(AppConfigService) config: AppConfigService) {
    this.material = Buffer.from(config.env.IDENTITY_HASH_KEY, 'utf8');
    this.version = `env:${config.env.IDENTITY_HASH_KEY_VERSION}`;
  }

  async mac(message: Buffer): Promise<Buffer> {
    return createHmac('sha256', this.material).update(message).digest();
  }
}

@Injectable()
export class IdentityHasher {
  constructor(@Inject(IDENTITY_MAC_PROVIDER) private readonly macProvider: IdentityMacProvider) {}

  get keyVersion(): string {
    return this.macProvider.version;
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

    const tag = await this.macProvider.mac(Buffer.from(normalized, 'utf8'));

    // KMS HMAC-SHA256 32 baytlık etiket döner; başka bir uzunluk, anahtarın yanlış
    // algoritmayla oluşturulduğu anlamına gelir ve sessizce kabul edilmemelidir.
    if (tag.byteLength !== 32) {
      throw new Error(
        `kimlik MAC etiketi 32 bayt olmalı (HMAC-SHA256), ${tag.byteLength} bayt alındı`,
      );
    }

    return tag.toString('hex');
  }

  /** Sabit zamanlı karşılaştırma: hash eşleşmesi zamanlama sızdırmamalı. */
  equals(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
