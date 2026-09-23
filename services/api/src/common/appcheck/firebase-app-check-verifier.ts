import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AppConfigService } from '../config/app-config.service';
import {
  InvalidAppCheckTokenError,
  type AppCheckVerifier,
  type VerifiedAppCheckToken,
} from './app-check-verifier';

/** Firebase App Check'in token imzalama anahtarlarını yayınladığı adres. */
const APP_CHECK_JWKS_URL = new URL('https://firebaseappcheck.googleapis.com/v1/jwks');

/**
 * Firebase App Check token doğrulaması.
 *
 * Doğrulanan iddialar: imza (RS256), issuer (proje numarası), audience
 * (`projects/<numara>`), exp/iat ve `sub` (uygulama kimliği). `jose`'nin uzak
 * JWKS önbelleği anahtar rotasyonunu kendisi yönetir.
 */
@Injectable()
export class FirebaseAppCheckVerifier implements AppCheckVerifier {
  private readonly jwks = createRemoteJWKSet(APP_CHECK_JWKS_URL);

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  async verify(rawToken: string): Promise<VerifiedAppCheckToken> {
    const projectNumber = this.config.env.FIREBASE_PROJECT_NUMBER;

    let claims: JWTPayload;
    try {
      const result = await jwtVerify(rawToken, this.jwks, {
        algorithms: ['RS256'],
        issuer: `https://firebaseappcheck.googleapis.com/${projectNumber}`,
        audience: `projects/${projectNumber}`,
        clockTolerance: 5,
      });
      claims = result.payload;
    } catch (error) {
      throw new InvalidAppCheckTokenError(
        error instanceof Error ? error.name : 'verification_failed',
      );
    }

    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new InvalidAppCheckTokenError('missing_subject');
    }

    return { appId: claims.sub };
  }
}
