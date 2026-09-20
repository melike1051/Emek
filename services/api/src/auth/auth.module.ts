import { Module } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { FirebaseTokenVerifier } from './firebase-token-verifier';
import { MockTokenVerifier } from './mock-token-verifier';
import { RolesGuard } from './roles.guard';
import { TOKEN_VERIFIER, type TokenVerifier } from './token-verifier';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    AuthGuard,
    RolesGuard,
    {
      provide: TOKEN_VERIFIER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): TokenVerifier =>
        // Mock doğrulayıcı yalnızca development/test'te seçilebilir; production ile
        // birlikte verilmesi config şemasında engellenir (ADR-0016).
        config.env.AUTH_PROVIDER === 'mock'
          ? new MockTokenVerifier()
          : new FirebaseTokenVerifier(config),
    },
  ],
  exports: [AuthGuard, RolesGuard, TOKEN_VERIFIER],
})
export class AuthModule {}
