import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { Logger } from 'pino';
import { AppConfigService } from '../config/app-config.service';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import { REDIS_CLIENT } from './redis.tokens';

export { REDIS_CLIENT } from './redis.tokens';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfigService, ROOT_LOGGER],
      useFactory: (config: AppConfigService, logger: Logger): Redis => {
        const client = new Redis(config.env.REDIS_URL, {
          // Bağlantı kurulurken gelen komutlar kısa süre kuyruğa alınır. Kuyruk kapalı
          // olursa (enableOfflineQueue: false) bağlantı hazır olmadan gelen İLK komut
          // reddedilir ve Redis ayaktayken bile "down" raporlanır.
          // Süresiz bekleme riski `maxRetriesPerRequest` ve `commandTimeout` ile sınırlanır:
          // Redis gerçekten erişilemezse komut hızla hata verir, istek askıda kalmaz.
          enableOfflineQueue: true,
          maxRetriesPerRequest: 2,
          commandTimeout: 1000,
          connectTimeout: 3000,
          retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
        });

        // Dinleyici olmadan 'error' olayı süreci düşürür. Redis erişilemezken uygulama
        // ayakta kalmalı (ADR-0003), bu yüzden hata loglanır ve ioredis yeniden dener.
        // Gürültüyü önlemek için yalnızca durum değişiminde log yazılır.
        let reportedDown = false;
        client.on('error', (error: Error) => {
          if (!reportedDown) {
            reportedDown = true;
            logger.warn({ err: error.message }, 'Redis bağlantısı kullanılamıyor');
          }
        });
        client.on('ready', () => {
          if (reportedDown) {
            reportedDown = false;
            logger.info('Redis bağlantısı yeniden kuruldu');
          }
        });

        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
