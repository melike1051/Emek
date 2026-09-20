import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigService } from '../config/app-config.service';
import { POSTGRES_POOL } from './database.tokens';
import { UnitOfWork } from './unit-of-work';

export { POSTGRES_POOL } from './database.tokens';

@Global()
@Module({
  providers: [
    {
      provide: POSTGRES_POOL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Pool =>
        new Pool({
          connectionString: config.env.DATABASE_URL,
          max: config.env.DATABASE_POOL_MAX,
          // Bağlantı kurulamıyorsa istek süresiz beklemez; hata anlamlı biçimde yüzeye çıkar.
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 30000,
        }),
    },
    UnitOfWork,
  ],
  exports: [POSTGRES_POOL, UnitOfWork],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
