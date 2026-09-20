import { Module } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { UsersModule } from '../users/users.module';
import {
  EnvIdentityHashKeyProvider,
  IDENTITY_HASH_KEY_PROVIDER,
  IdentityHasher,
  KmsIdentityHashKeyProvider,
  type IdentityHashKeyProvider,
} from './identity-hasher';
import { IDENTITY_PROVIDER, type IdentityVerificationProvider } from './identity-provider.port';
import { IdentityController } from './identity.controller';
import { IdentityRepository } from './identity.repository';
import { IdentityService } from './identity.service';
import { MockIdentityProvider } from './mock-identity-provider';

@Module({
  imports: [UsersModule],
  controllers: [IdentityController],
  providers: [
    IdentityService,
    IdentityRepository,
    IdentityHasher,
    MockIdentityProvider,
    {
      provide: IDENTITY_HASH_KEY_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): IdentityHashKeyProvider =>
        // Production'da yalnızca KMS kabul edilir (env.schema bunu zorlar); KMS adapter'ı
        // Faz 13'te bağlanana kadar açıkça hata verir — sessizce zayıf anahtara düşmez.
        config.env.IDENTITY_HASH_KEY_SOURCE === 'kms'
          ? new KmsIdentityHashKeyProvider()
          : new EnvIdentityHashKeyProvider(config),
    },
    {
      provide: IDENTITY_PROVIDER,
      inject: [AppConfigService, MockIdentityProvider],
      useFactory: (
        config: AppConfigService,
        mock: MockIdentityProvider,
      ): IdentityVerificationProvider => {
        if (config.env.IDENTITY_PROVIDER === 'mock') {
          return mock;
        }
        // Gerçek sağlayıcı adapter'ı, sözleşme ve erişim modeli doğrulandığında
        // eklenecek (risk R-01). Config production'da mock'u zaten reddeder.
        throw new Error(
          `IDENTITY_PROVIDER=${config.env.IDENTITY_PROVIDER} için adapter henüz uygulanmadı`,
        );
      },
    },
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
