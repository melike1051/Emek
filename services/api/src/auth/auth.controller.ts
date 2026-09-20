import { Controller, Headers, Ip, Post } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { UsersService } from '../users/users.service';
import { Public } from './auth.decorators';
import { AuthSessionResponseDto } from './dto/session.dto';
import { InvalidTokenError, TOKEN_VERIFIER, type TokenVerifier } from './token-verifier';

const BEARER_PREFIX = 'Bearer ';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly tokenVerifier: TokenVerifier,
    private readonly users: UsersService,
  ) {}

  /**
   * Oturum kurulumu: sağlayıcı token'ı doğrulanır, Emek kullanıcısı yoksa oluşturulur.
   *
   * Bu endpoint `@Public()`'tir çünkü AuthGuard mevcut bir Emek kullanıcısı arar —
   * ilk girişte henüz yoktur. Token doğrulaması burada da zorunludur.
   *
   * Oran sınırı: token doğrulama maliyetli bir işlem ve kayıt akışının kötüye
   * kullanımı (hesap seli) burada engellenir.
   */
  @Post('session')
  @Public()
  @RateLimit({ name: 'auth-session', limit: 20, windowSeconds: 60 })
  async createSession(
    @Headers('authorization') authorization: string | undefined,
    @Ip() ip: string,
  ): Promise<AuthSessionResponseDto> {
    if (authorization === undefined || !authorization.startsWith(BEARER_PREFIX)) {
      throw new BusinessException(ErrorCode.UNAUTHENTICATED);
    }

    const rawToken = authorization.slice(BEARER_PREFIX.length).trim();

    let verified;
    try {
      verified = await this.tokenVerifier.verify(rawToken);
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        throw new BusinessException(ErrorCode.UNAUTHENTICATED);
      }
      throw error;
    }

    const { user, registered } = await this.users.ensureSession({
      subject: verified.subject,
      ...(verified.email !== undefined ? { email: verified.email } : {}),
      ...(verified.phoneNumber !== undefined ? { phone: verified.phoneNumber } : {}),
      ipAddress: ip,
    });

    return { userId: user.id, roles: user.roles, status: user.status, registered };
  }
}
