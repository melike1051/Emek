import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AppConfigService } from '../common/config/app-config.service';
import { InvalidTokenError, type TokenVerifier, type VerifiedToken } from './token-verifier';

/** Google'ın Firebase ID token imzalama anahtarlarını yayınladığı adres. */
const FIREBASE_JWKS_URL = new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
);

interface FirebaseClaims extends JWTPayload {
  email?: string;
  email_verified?: boolean;
  phone_number?: string;
  auth_time?: number;
}

/**
 * Firebase ID token doğrulaması (ADR-0016).
 *
 * `createRemoteJWKSet` anahtar önbelleği ve rotasyonunu yönetir. Doğrulanan iddialar:
 * imza (RS256), issuer, audience, exp/iat ve Firebase'e özgü `sub` + `auth_time`.
 */
@Injectable()
export class FirebaseTokenVerifier implements TokenVerifier {
  private readonly jwks = createRemoteJWKSet(FIREBASE_JWKS_URL);

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  async verify(rawToken: string): Promise<VerifiedToken> {
    const projectId = this.config.env.FIREBASE_PROJECT_ID;

    let claims: FirebaseClaims;
    try {
      const result = await jwtVerify<FirebaseClaims>(rawToken, this.jwks, {
        algorithms: ['RS256'],
        issuer: `https://securetoken.google.com/${projectId}`,
        audience: projectId,
        // Saat kaymasına küçük bir tolerans; daha fazlası süresi geçmiş token kabul etmek olur.
        clockTolerance: 5,
      });
      claims = result.payload;
    } catch (error) {
      throw new InvalidTokenError(error instanceof Error ? error.name : 'verification_failed');
    }

    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new InvalidTokenError('missing_subject');
    }

    if (typeof claims.auth_time !== 'number') {
      throw new InvalidTokenError('missing_auth_time');
    }

    return {
      subject: claims.sub,
      emailVerified: claims.email_verified === true,
      authTime: new Date(claims.auth_time * 1000),
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
      ...(typeof claims.phone_number === 'string' ? { phoneNumber: claims.phone_number } : {}),
    };
  }
}
