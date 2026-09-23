import { KeyManagementServiceClient } from '@google-cloud/kms';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { crc32c } from './crc32c';
import type { IdentityMacProvider } from './identity-hasher';

/**
 * Production kimlik MAC sağlayıcısı — Cloud KMS `macSign` (Faz 13, R-39).
 *
 * Anahtar materyali **hiçbir zaman** uygulamaya inmez: mesaj KMS'e gider, etiket geri
 * gelir. Anahtar `HMAC_SHA256` amaçlı, non-exportable ve rotasyonsuzdur (ADR-0004 §5);
 * bu yüzden **sürüm kaynak adı** açıkça yapılandırılır — "primary" sürüme bırakmak,
 * KMS tarafında yapılacak bir değişikliğin tekilliği sessizce bozmasına izin verirdi.
 *
 * Hata **yutulmaz**: KMS erişilemezse doğrulama akışı durur. Zayıf bir yedek anahtara
 * düşmek, mükerrer hesap kontrolünü kâğıt üzerinde bırakırdı (ADR-0004 §3).
 */
@Injectable()
export class KmsIdentityMacProvider implements IdentityMacProvider, OnApplicationBootstrap {
  readonly version: string;

  constructor(
    private readonly client: Pick<KeyManagementServiceClient, 'macSign'>,
    private readonly keyVersionName: string,
  ) {
    // Sürüm etiketi teşhis içindir: hangi kaydın hangi anahtar sürümüyle üretildiği.
    const versionSuffix = keyVersionName.slice(keyVersionName.lastIndexOf('/') + 1);
    this.version = `kms:${versionSuffix}`;
  }

  static create(keyVersionName: string): KmsIdentityMacProvider {
    return new KmsIdentityMacProvider(new KeyManagementServiceClient(), keyVersionName);
  }

  /**
   * Anahtarın erişilebilir ve doğru algoritmada olduğunu **başlatmada** doğrular.
   *
   * Aksi halde hata, ilk kimlik doğrulama isteğinde ortaya çıkardı — yani kullanıcı
   * akışının ortasında. Kanarya mesajı sabittir ve hiçbir kişisel veri içermez.
   */
  async onApplicationBootstrap(): Promise<void> {
    const tag = await this.mac(Buffer.from('emek-kms-startup-canary', 'utf8'));
    if (tag.byteLength !== 32) {
      throw new Error(
        `Cloud KMS anahtarı HMAC_SHA256 değil (${tag.byteLength} baytlık etiket) — ` +
          'yanlış algoritma tekillik garantisini bozar (ADR-0004)',
      );
    }
  }

  async mac(message: Buffer): Promise<Buffer> {
    // Checksum **gönderilir**. `verifiedDataCrc32c` "istek doğrulandı mı" değil,
    // "gönderdiğin checksum bana ulaştı mı" demektir: göndermezsek alan her zaman
    // `false` döner ve kontrol ya hiçbir şey ölçmez ya da her çağrıyı düşürür.
    const [response] = await this.client.macSign({
      name: this.keyVersionName,
      data: message,
      dataCrc32c: { value: crc32c(message) },
    });

    const tag = response.mac;
    if (tag === null || tag === undefined) {
      throw new Error('Cloud KMS macSign boş etiket döndürdü');
    }

    // KMS veriyi bozuk aldıysa etiket başka bir mesaja aittir. Sessizce kabul etmek,
    // aynı kişi için farklı hash üretip tekilliği delerdi (ADR-0004 §3).
    if (response.verifiedDataCrc32c !== true) {
      throw new Error('Cloud KMS gönderilen veriyi doğrulayamadı (CRC32C uyuşmazlığı)');
    }

    // Etiketi üreten anahtar sürümü, istediğimiz sürüm olmalı: farklı bir sürüm
    // aynı kişi için farklı hash demektir (rotasyon yoktur — ADR-0004 §5).
    if (
      response.name !== undefined &&
      response.name !== null &&
      response.name !== this.keyVersionName
    ) {
      throw new Error(
        `Cloud KMS beklenenden farklı anahtar sürümü kullandı: ${response.name} ` +
          `(beklenen ${this.keyVersionName})`,
      );
    }

    return Buffer.isBuffer(tag) ? tag : Buffer.from(tag as Uint8Array);
  }
}
