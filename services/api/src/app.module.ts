import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { RedisModule } from './common/cache/redis.module';
import { AppConfigModule } from './common/config/app-config.module';
import { DatabaseModule } from './common/database/database.module';
import { LoggingModule } from './common/logging/logging.module';
import { RequestContextMiddleware } from './common/logging/request-context.middleware';
import { HealthModule } from './health/health.module';

@Module({
  imports: [AppConfigModule, LoggingModule, DatabaseModule, RedisModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
