import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from 'firebase/app-check';
import {
  browserSessionPersistence,
  getAuth,
  onIdTokenChanged,
  RecaptchaVerifier,
  setPersistence,
  signInWithPhoneNumber,
  signOut,
  type Auth,
  type ConfirmationResult,
} from 'firebase/auth';
import type { FirebaseWebConfig } from '../env';
import type { AuthAdapter } from './adapter';

/**
 * Firebase Auth (telefon OTP, ADR-0016) + App Check (ADR-0022).
 * Token kalıcılığı SDK'dadır; uygulama token'ı kendi depolamasına yazmaz (ADR-0024 §6).
 * `browserSessionPersistence`: ortak bilgisayarda sekme kapanınca oturum biter.
 */
export class FirebaseAuthAdapter implements AuthAdapter {
  readonly mode = 'firebase' as const;
  private readonly app: FirebaseApp;
  private readonly auth: Auth;
  private readonly appCheck: AppCheck | null;
  private readonly ready: Promise<void>;
  private verifier: RecaptchaVerifier | null = null;

  constructor(config: FirebaseWebConfig, appCheckSiteKey: string | null) {
    this.app = initializeApp(config);
    this.appCheck = appCheckSiteKey
      ? initializeAppCheck(this.app, {
          provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
          isTokenAutoRefreshEnabled: true,
        })
      : null;
    this.auth = getAuth(this.app);
    this.auth.languageCode = 'tr';
    this.ready = setPersistence(this.auth, browserSessionPersistence);
  }

  async getIdToken(): Promise<string | null> {
    await this.ready;
    return (await this.auth.currentUser?.getIdToken()) ?? null;
  }

  async getAppCheckToken(): Promise<string | null> {
    if (this.appCheck === null) return null;
    return (await getToken(this.appCheck, false)).token;
  }

  subscribe(listener: (signedIn: boolean) => void): () => void {
    return onIdTokenChanged(this.auth, (user) => listener(user !== null));
  }

  /** SMS kodu gönderir. `containerId`: görünmez reCAPTCHA'nın bağlanacağı öğe. */
  async sendCode(phoneE164: string, containerId: string): Promise<ConfirmationResult> {
    await this.ready;
    this.verifier ??= new RecaptchaVerifier(this.auth, containerId, { size: 'invisible' });
    try {
      return await signInWithPhoneNumber(this.auth, phoneE164, this.verifier);
    } catch (error) {
      // Başarısız denemeden sonra aynı widget yeniden kullanılamaz.
      this.verifier.clear();
      this.verifier = null;
      throw error;
    }
  }

  async signOut(): Promise<void> {
    await signOut(this.auth);
  }
}
