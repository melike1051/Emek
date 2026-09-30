import type { AuthAdapter } from './adapter';

const STORAGE_KEY = 'emek.mock-token';

/** Backend MockTokenVerifier biçimi: `mock:<subject>[:phone=<+90...>]`. */
export function buildMockToken(subject: string, phone?: string): string {
  const cleanSubject = subject.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cleanSubject)) {
    throw new Error('Geçersiz geliştirici kimliği: harf, rakam, "-" ve "_" kullanın.');
  }
  return phone ? `mock:${cleanSubject}:phone=${phone}` : `mock:${cleanSubject}`;
}

/**
 * Yalnızca geliştirme. Token sekme kapanınca silinir (`sessionStorage`); gerçek bir sır değildir —
 * backend onu yalnızca `AUTH_PROVIDER=mock` iken kabul eder ve production'da o mod başlamaz.
 */
export class MockAuthAdapter implements AuthAdapter {
  readonly mode = 'mock' as const;
  private readonly listeners = new Set<(signedIn: boolean) => void>();

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {}

  async getIdToken(): Promise<string | null> {
    return this.storage.getItem(STORAGE_KEY);
  }

  async getAppCheckToken(): Promise<string | null> {
    return null;
  }

  subscribe(listener: (signedIn: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.storage.getItem(STORAGE_KEY) !== null);
    return () => this.listeners.delete(listener);
  }

  signIn(subject: string, phone?: string): void {
    this.storage.setItem(STORAGE_KEY, buildMockToken(subject, phone));
    this.emit(true);
  }

  async signOut(): Promise<void> {
    this.storage.removeItem(STORAGE_KEY);
    this.emit(false);
  }

  private emit(signedIn: boolean): void {
    for (const listener of this.listeners) listener(signedIn);
  }
}
