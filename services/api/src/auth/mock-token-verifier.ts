import { Injectable } from '@nestjs/common';
import { InvalidTokenError, type TokenVerifier, type VerifiedToken } from './token-verifier';

/**
 * Yerel geliştirme ve test için deterministik doğrulayıcı.
 *
 * Token biçimi: `mock:<subject>[:email=<e-posta>][:phone=<+90...>]`
 *
 * `AUTH_PROVIDER=mock` yalnızca development/test içindir; production ile birlikte
 * verilirse servis hiç başlamaz (config şeması, ADR-0016).
 */
@Injectable()
export class MockTokenVerifier implements TokenVerifier {
  async verify(rawToken: string): Promise<VerifiedToken> {
    if (!rawToken.startsWith('mock:')) {
      throw new InvalidTokenError('unsupported_token');
    }

    const [, subject, ...attributes] = rawToken.split(':');
    if (subject === undefined || subject.length === 0) {
      throw new InvalidTokenError('missing_subject');
    }

    const parsed = new Map(
      attributes
        .map((attribute) => attribute.split('='))
        .filter((parts): parts is [string, string] => parts.length === 2)
        .map(([key, value]) => [key, value]),
    );

    const email = parsed.get('email');
    const phone = parsed.get('phone');

    return {
      subject,
      emailVerified: email !== undefined,
      authTime: new Date(),
      ...(email !== undefined ? { email } : {}),
      ...(phone !== undefined ? { phoneNumber: phone } : {}),
    };
  }
}
