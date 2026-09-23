/** Doğrulanmış App Check onayı. `appId` teşhis amaçlıdır, yetki kaynağı değildir. */
export interface VerifiedAppCheckToken {
  appId: string;
}

export class InvalidAppCheckTokenError extends Error {
  constructor(reason: string) {
    super(`App Check token geçersiz: ${reason}`);
    this.name = 'InvalidAppCheckTokenError';
  }
}

/**
 * İstemci bütünlüğü doğrulaması (Firebase App Check) için port.
 *
 * App Check **kimlik doğrulaması değildir**: "bu istek gerçekten bizim
 * uygulamamızdan mı geliyor" sorusunu yanıtlar. Yetkilendirme her zaman
 * `AuthGuard` + RBAC ile yapılır; App Check onun yerine geçmez, önüne eklenir.
 */
export interface AppCheckVerifier {
  verify(rawToken: string): Promise<VerifiedAppCheckToken>;
}

export const APP_CHECK_VERIFIER = Symbol('APP_CHECK_VERIFIER');
