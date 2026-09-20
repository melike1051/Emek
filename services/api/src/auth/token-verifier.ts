/**
 * Kimlik sağlayıcısından gelen token'ı doğrulayan port (ADR-0016).
 *
 * Domain, Firebase'e özgü hiçbir tipi görmez: doğrulanmış token normalize edilmiş
 * alanlarla döner. Sağlayıcı değişirse yalnızca adapter değişir.
 */

export interface VerifiedToken {
  /** Sağlayıcıdaki kararlı kullanıcı kimliği (Firebase `sub`/`uid`). */
  subject: string;
  email?: string;
  emailVerified: boolean;
  phoneNumber?: string;
  /** Kullanıcının kimlik doğruladığı an; oturum yaşı kararlarında kullanılır. */
  authTime: Date;
}

export interface TokenVerifier {
  verify(rawToken: string): Promise<VerifiedToken>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** Doğrulama başarısızlıkları tek tip: nedeni istemciye ayrıntılandırılmaz. */
export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidTokenError';
  }
}
