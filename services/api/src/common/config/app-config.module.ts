import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.schema';

@Global()
@Module({
  providers: [
    {
      provide: AppConfigService,
      useFactory: (): AppConfigService => new AppConfigService(validateEnv(process.env)),
    },
  ],
  exports: [AppConfigService],
})
export class AppConfigModule {}
