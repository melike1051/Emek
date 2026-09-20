/**
 * Object storage portu (dijital ispat dosyaları).
 *
 * Dosya içeriği **API'den geçmez**: istemci doğrudan storage'a imzalı URL ile yükler.
 * Binary'i NestJS üzerinden akıtmak Cloud Run bellek/istek süresi sınırlarını zorlar ve
 * hiçbir şey kazandırmaz — bütünlük `sha256` ile zaten doğrulanır.
 *
 * Nesneler **private**'tır. Public URL üretme yeteneği bu portta bilinçli olarak yoktur:
 * olsa, bir yerde yanlışlıkla çağrılabilir ve müşteri evinin fotoğrafı internete açılırdı.
 */

export interface SignedUploadUrl {
  url: string;
  /** İstemcinin yüklemede kullanması gereken başlıklar (ör. içerik tipi sabitlenir). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface SignedDownloadUrl {
  url: string;
  expiresAt: Date;
}

export interface StorageProvider {
  readonly name: string;
  /** Yükleme için kısa ömürlü imzalı URL üretir. */
  createUploadUrl(input: {
    storageKey: string;
    contentType: string;
    maxBytes: number;
  }): Promise<SignedUploadUrl>;
  /** Okuma için kısa ömürlü imzalı URL üretir. */
  createDownloadUrl(storageKey: string): Promise<SignedDownloadUrl>;
  /**
   * Yüklenen nesnenin gerçek özeti ve boyutu.
   *
   * İstemcinin bildirdiği `sha256`'ya güvenilmez: doğrulama storage'daki nesnenin
   * kendisinden yapılır, aksi halde "kanıt" istemcinin beyanı olurdu.
   */
  statObject(storageKey: string): Promise<{ sha256: string; sizeBytes: number } | null>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export class StorageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}
