import type { AssuranceLevel, VerificationPurpose, VerificationStatus } from './identity.types';

/**
 * Identity Verification Adapter Layer (ADR-0005).
 *
 * Core backend somut bir sağlayıcıyı tanımaz. EKDS/e-ID/NFC veya ticari bir KYC
 * sağlayıcısı bu portun arkasına takılır; sağlayıcı değiştiğinde domain değişmez.
 *
 * **Ham kimlik verisi bu portun dışına çıkmaz.** Adapter, ham veriyi görür, doğrular
 * ve yalnızca referans + hash + sonuç döner (ADR-0004 §4, ADR-0005).
 */

export interface ProviderCapabilities {
  methods: string[];
  livenessSupported: boolean;
  maxAssuranceLevel: AssuranceLevel;
  /**
   * Sağlayıcı, aynı kişi için her seferinde aynı `identityHash`'i üretebiliyor mu?
   * Üretemiyorsa tekillik gerektiren akışlarda (kayıt, recovery) tek başına kullanılamaz
   * (ADR-0004 §3).
   */
  producesDeterministicIdentityHash: boolean;
}

export interface StartSessionInput {
  /** Sağlayıcıya gönderilen opak kullanıcı referansı; Emek user id'si değildir. */
  userRef: string;
  method: string;
  purpose: VerificationPurpose;
}

export interface StartedSession {
  externalSessionId: string;
  /** İstemcinin sağlayıcı akışını başlatmak için kullandığı kısa ömürlü token. */
  clientToken: string;
  expiresAt: Date;
}

export interface VerificationResult {
  externalSessionId: string;
  status: VerificationStatus;
  /** Sağlayıcıdaki kararlı kimlik referansı. Ham kimlik verisi DEĞİL. */
  providerSubjectId: string;
  /**
   * Ham kimlik verisinden adapter içinde üretilen HMAC (ADR-0004 §4).
   * Sağlayıcı deterministik referans üretemiyorsa yoktur.
   */
  identityHash?: string;
  /** Hash'i üreten anahtar sürümü — teşhis amaçlı (ADR-0004 §5). */
  hashKeyVersion?: string;
  assuranceLevel: AssuranceLevel;
  /** Sınıflandırılmış sonuç kodu; sağlayıcının ham hata metni taşınmaz. */
  resultCode: string;
  verifiedAt?: Date;
}

export interface IdentityVerificationProvider {
  readonly name: string;
  capabilities(): ProviderCapabilities;
  startSession(input: StartSessionInput): Promise<StartedSession>;
  getSessionResult(externalSessionId: string): Promise<VerificationResult>;
  /** İmza doğrulaması adapter'ın içindedir: imzasız/yanlış imzalı çağrı reddedilir. */
  verifyCallback(rawBody: string, signature: string | undefined): Promise<VerificationResult>;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');

/** Sağlayıcı kaynaklı hatalar; nedeni istemciye ayrıntılandırılmaz. */
export class IdentityProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityProviderError';
  }
}

/** Sağlayıcıya ulaşılamadığında: akış PENDING kalır, yarım kayıt oluşmaz (T-03). */
export class IdentityProviderUnavailableError extends IdentityProviderError {
  constructor(message = 'identity provider unavailable') {
    super('PROVIDER_UNAVAILABLE', message);
    this.name = 'IdentityProviderUnavailableError';
  }
}
