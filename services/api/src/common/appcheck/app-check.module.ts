import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { APP_CHECK_VERIFIER, type AppCheckVerifier } from './app-check-verifier';
import { AppCheckGuard } from './app-check.guard';
import { FirebaseAppCheckVerifier } from './firebase-app-check-verifier';
import { MockAppCheckVerifier } from './mock-app-check-verifier';

@Global()
@Module({
  providers: [
    {
      provide: APP_CHECK_VERIFIER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): AppCheckVerifier =>
        config.env.APP_CHECK_PROVIDER === 'firebase'
          ? new FirebaseAppCheckVerifier(config)
          : new MockAppCheckVerifier(),
    },
    AppCheckGuard,
  ],
  exports: [APP_CHECK_VERIFIER, AppCheckGuard],
})
export class AppCheckModule {}
