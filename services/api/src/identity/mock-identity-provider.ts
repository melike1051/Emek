import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { IdentityHasher } from './identity-hasher';
import {
  IdentityProviderError,
  IdentityProviderUnavailableError,
  type IdentityVerificationProvider,
  type ProviderCapabilities,
  type StartSessionInput,
  type StartedSession,
  type VerificationResult,
} from './identity-provider.port';
import type { AssuranceLevel } from './identity.types';

interface MockSession {
  externalSessionId: string;
  userRef: string;
  method: string;
  expiresAt: Date;
  /** Sağlayıcı akışı tamamlandığında oluşan sonuç. */
  result?: VerificationResult;
}

/**
 * Test ve yerel geliştirme için deterministik identity sağlayıcısı (ADR-0005).
 *
 * Gerçek sağlayıcı sözleşmesi imzalanmadan Faz 4-8'in geliştirilebilmesi için vardır;
 * `IDENTITY_PROVIDER=mock` production'da config seviyesinde reddedilir.
 *
 * Callback yükü, gerçek sağlayıcılarda olduğu gibi **imzalıdır** ve imza adapter içinde
 * doğrulanır: imza doğrulamasının domain katmanına sızması, sağlayıcı değiştiğinde
 * core'un değişmesi demek olurdu.
 */
@Injectable()
export class MockIdentityProvider implements IdentityVerificationProvider {
  readonly name = 'mock';

  private readonly sessions = new Map<string, MockSession>();
  /** Test kancası: sağlayıcı arızası simülasyonu (T-03). Üretim akışında kullanılmaz. */
  private unavailable = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly hasher: IdentityHasher,
  ) {}

  capabilities(): ProviderCapabilities {
    return {
      methods: ['NFC_EID', 'DOCUMENT_LIVENESS'],
      livenessSupported: true,
      maxAssuranceLevel: 'HIGH',
      producesDeterministicIdentityHash: true,
    };
  }

  /** Yalnızca testler için: sağlayıcının erişilemez olduğunu simüle eder. */
  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  async startSession(input: StartSessionInput): Promise<StartedSession> {
    if (this.unavailable) {
      throw new IdentityProviderUnavailableError();
    }

    const externalSessionId = `mock-ses-${randomUUID()}`;
    const expiresAt = new Date(
      Date.now() + this.config.env.VERIFICATION_SESSION_TTL_SECONDS * 1000,
    );

    this.sessions.set(externalSessionId, {
      externalSessionId,
      userRef: input.userRef,
      method: input.method,
      expiresAt,
    });

    return {
      externalSessionId,
      clientToken: `mock-token-${externalSessionId}`,
      expiresAt,
    };
  }

  async getSessionResult(externalSessionId: string): Promise<VerificationResult> {
    const session = this.sessions.get(externalSessionId);
    if (session === undefined) {
      throw new IdentityProviderError('SESSION_NOT_FOUND', 'session not found');
    }

    if (session.result !== undefined) {
      return session.result;
    }

    if (session.expiresAt.getTime() < Date.now()) {
      return {
        externalSessionId,
        status: 'EXPIRED',
        providerSubjectId: '',
        assuranceLevel: 'LOW',
        resultCode: 'SESSION_EXPIRED',
      };
    }

    return {
      externalSessionId,
      status: 'PENDING',
      providerSubjectId: '',
      assuranceLevel: 'LOW',
      resultCode: 'PENDING',
    };
  }

  /**
   * İmzalı callback. Yük biçimi:
   * `{ externalSessionId, outcome: 'VERIFIED'|'REJECTED', nationalId?, assuranceLevel?, resultCode? }`
   *
   * `nationalId` **yalnızca adapter içinde** görülür: hash'e çevrilir ve atılır.
   * Domain katmanına ham kimlik verisi hiç ulaşmaz (ADR-0005).
   */
  async verifyCallback(
    rawBody: string,
    signature: string | undefined,
  ): Promise<VerificationResult> {
    if (signature === undefined || !this.isSignatureValid(rawBody, signature)) {
      throw new IdentityProviderError('INVALID_SIGNATURE', 'callback signature mismatch');
    }

    let payload: {
      externalSessionId?: unknown;
      outcome?: unknown;
      nationalId?: unknown;
      assuranceLevel?: unknown;
      resultCode?: unknown;
    };

    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      throw new IdentityProviderError('INVALID_PAYLOAD', 'callback payload is not valid JSON');
    }

    const externalSessionId = payload.externalSessionId;
    if (typeof externalSessionId !== 'string' || externalSessionId.length === 0) {
      throw new IdentityProviderError('INVALID_PAYLOAD', 'externalSessionId missing');
    }

    const session = this.sessions.get(externalSessionId);
    if (session === undefined) {
      throw new IdentityProviderError('SESSION_NOT_FOUND', 'session not found');
    }

    if (payload.outcome === 'REJECTED') {
      const result: VerificationResult = {
        externalSessionId,
        status: 'REJECTED',
        providerSubjectId: '',
        assuranceLevel: 'LOW',
        resultCode: typeof payload.resultCode === 'string' ? payload.resultCode : 'REJECTED',
      };
      session.result = result;
      return result;
    }

    const nationalId = payload.nationalId;
    if (typeof nationalId !== 'string' || nationalId.length === 0) {
      throw new IdentityProviderError('INVALID_PAYLOAD', 'identity reference missing');
    }

    // Ham kimlik verisi burada hash'e dönüşür ve bir daha kullanılmaz.
    const identityHash = await this.hasher.hash(nationalId);
    const assuranceLevel: AssuranceLevel =
      payload.assuranceLevel === 'HIGH' || payload.assuranceLevel === 'SUBSTANTIAL'
        ? payload.assuranceLevel
        : 'LOW';

    const result: VerificationResult = {
      externalSessionId,
      status: 'VERIFIED',
      // Gerçek sağlayıcıda subject, sağlayıcının kendi kararlı kimliğidir. Mock'ta
      // hash'ten türetilir ki aynı kişi her seferinde aynı subject'i alsın.
      providerSubjectId: `mock-subject-${identityHash.slice(0, 32)}`,
      identityHash,
      hashKeyVersion: this.hasher.keyVersion,
      assuranceLevel,
      resultCode: 'VERIFIED',
      verifiedAt: new Date(),
    };

    session.result = result;
    return result;
  }

  /** Testlerin imzalı yük üretebilmesi için; gerçek sağlayıcıda karşılığı yoktur. */
  signPayload(rawBody: string): string {
    return createHmac('sha256', this.config.env.IDENTITY_CALLBACK_SECRET)
      .update(rawBody, 'utf8')
      .digest('hex');
  }

  private isSignatureValid(rawBody: string, signature: string): boolean {
    const expected = Buffer.from(this.signPayload(rawBody), 'utf8');
    const received = Buffer.from(signature, 'utf8');
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
}
