import { Module } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { MockStorageProvider } from './mock-storage-provider';
import { STORAGE_PROVIDER, type StorageProvider } from './storage.port';

@Module({
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    MockStorageProvider,
    {
      provide: STORAGE_PROVIDER,
      inject: [AppConfigService, MockStorageProvider],
      useFactory: (config: AppConfigService, mock: MockStorageProvider): StorageProvider => {
        if (config.env.STORAGE_PROVIDER === 'mock') {
          return mock;
        }
        // GCS adapter'ı Faz 13'te (Terraform + servis hesabı + KMS ile birlikte) bağlanacak.
        // Config production'da mock'u zaten reddeder: sessizce belleğe yazan bir
        // "kanıt deposu" ile production'a çıkmak mümkün olmamalı.
        throw new Error(
          `STORAGE_PROVIDER=${config.env.STORAGE_PROVIDER} için adapter henüz uygulanmadı`,
        );
      },
    },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
