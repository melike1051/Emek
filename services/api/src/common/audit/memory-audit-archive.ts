import { Injectable } from '@nestjs/common';
import { AuditArchiveError, type AuditArchive } from './audit-archive.port';

/**
 * Bellekte tutan arşiv — yalnızca geliştirme ve test içindir.
 *
 * Süreç yeniden başladığında arşiv kaybolur; "bağımsız kopya" iddiası bununla
 * taşınamaz. Production config'i bu uygulamayı reddeder (env.schema).
 */
@Injectable()
export class MemoryAuditArchive implements AuditArchive {
  readonly name = 'memory';

  private readonly objects = new Map<string, { body: string; retentionUntil: Date }>();

  put(input: { storageKey: string; body: string; retentionUntil: Date }): Promise<void> {
    if (this.objects.has(input.storageKey)) {
      // Retention-locked depolamada üzerine yazma reddedilir; burada da reddedilmeli.
      return Promise.reject(new AuditArchiveError(`arşiv nesnesi zaten var: ${input.storageKey}`));
    }
    this.objects.set(input.storageKey, {
      body: input.body,
      retentionUntil: input.retentionUntil,
    });
    return Promise.resolve();
  }

  /** Test yardımcısı: yazılmış parçayı okur. Üretim akışında kullanılmaz. */
  read(storageKey: string): string | undefined {
    return this.objects.get(storageKey)?.body;
  }
}
