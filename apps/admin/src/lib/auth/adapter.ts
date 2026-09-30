/**
 * Kimlik sağlayıcı soyutlaması: uygulamanın geri kalanı Firebase'i doğrudan bilmez.
 * Yerel geliştirmede backend `AUTH_PROVIDER=mock` ile eşleşen `MockAuthAdapter` kullanılır.
 */
export interface AuthAdapter {
  readonly mode: 'firebase' | 'mock';
  /** Geçerli ID token'ı; oturum yoksa `null`. Süresi dolan token'ı yeniler. */
  getIdToken(): Promise<string | null>;
  /** App Check token'ı; App Check kapalıysa `null`. */
  getAppCheckToken(): Promise<string | null>;
  /** Oturum değişikliklerini dinler; ilk çağrı mevcut durumu bildirir. */
  subscribe(listener: (signedIn: boolean) => void): () => void;
  signOut(): Promise<void>;
}
