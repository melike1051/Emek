import { Module } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { UsersModule } from '../users/users.module';
import {
  EnvIdentityMacProvider,
  IDENTITY_MAC_PROVIDER,
  IdentityHasher,
  type IdentityMacProvider,
} from './identity-hasher';
import { KmsIdentityMacProvider } from './kms-identity-mac-provider';
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
      provide: IDENTITY_MAC_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): IdentityMacProvider => {
        // Production'da yalnızca KMS kabul edilir (env.schema bunu zorlar).
        if (config.env.IDENTITY_HASH_KEY_SOURCE !== 'kms') {
          return new EnvIdentityMacProvider(config);
        }
        const keyName = config.env.IDENTITY_KMS_KEY_NAME;
        if (keyName === undefined) {
          // Config katmanı bunu zaten reddeder; burada da kontrol edilir çünkü
          // sessizce ortam değişkenindeki anahtara düşmek kabul edilemez.
          throw new Error('IDENTITY_HASH_KEY_SOURCE=kms iken IDENTITY_KMS_KEY_NAME zorunludur');
        }
        return KmsIdentityMacProvider.create(keyName);
      },
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
