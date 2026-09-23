/**
 * Retention-locked audit arşivi portu (ADR-0013 §8).
 *
 * Doğrulanmış zincir parçaları buraya yazılır. Bucket'ın **retention policy**'si
 * nesnenin `retentionUntil`'a kadar silinmesini/üzerine yazılmasını engeller:
 * veritabanına tam erişimi olan bir saldırgan bile arşiv kopyasını değiştiremez.
 * Zincir böylece tamper-evident olmaktan çıkıp bağımsız olarak doğrulanabilir
 * hale gelir.
 *
 * Gerçek GCS uygulaması ve bucket retention policy'si **Faz 13'e** aittir
 * (Terraform ile sağlanır). Bu fazda port, in-memory uygulama ve akışın kendisi
 * vardır; production config'i mock arşivi kabul etmez.
 */
export interface AuditArchive {
  readonly name: string;
  /**
   * Parçayı değişmez depolamaya yazar ve nesne anahtarını döner.
   *
   * Aynı anahtarla ikinci kez yazmak **hata**dır: retention-locked depolamada
   * üzerine yazma zaten reddedilir, burada sessizce başarılı görünmemelidir.
   */
  put(input: { storageKey: string; body: string; retentionUntil: Date }): Promise<void>;
}

export const AUDIT_ARCHIVE = Symbol('AUDIT_ARCHIVE');

export class AuditArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditArchiveError';
  }
}
