import { Injectable } from '@nestjs/common';
import {
  InvalidAppCheckTokenError,
  type AppCheckVerifier,
  type VerifiedAppCheckToken,
} from './app-check-verifier';

/** Mock token biçimi: `appcheck:<appId>`. Yalnızca development/test içindir. */
const MOCK_PREFIX = 'appcheck:';

/**
 * Yerel geliştirme ve test için App Check doğrulayıcısı.
 *
 * Production'da seçilmesi config şemasında engellenir (env.schema superRefine):
 * mock doğrulayıcı üretimde istemci bütünlüğü iddiasını tamamen boşa çıkarırdı.
 */
@Injectable()
export class MockAppCheckVerifier implements AppCheckVerifier {
  verify(rawToken: string): Promise<VerifiedAppCheckToken> {
    if (!rawToken.startsWith(MOCK_PREFIX)) {
      return Promise.reject(new InvalidAppCheckTokenError('malformed'));
    }

    const appId = rawToken.slice(MOCK_PREFIX.length);
    if (appId.length === 0) {
      return Promise.reject(new InvalidAppCheckTokenError('missing_subject'));
    }

    return Promise.resolve({ appId });
  }
}
