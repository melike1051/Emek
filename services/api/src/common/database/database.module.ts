import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigService } from '../config/app-config.service';

export const POSTGRES_POOL = Symbol('POSTGRES_POOL');

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
  ],
  exports: [POSTGRES_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
