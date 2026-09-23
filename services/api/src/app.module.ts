import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AddressesModule } from './addresses/addresses.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { RolesGuard } from './auth/roles.guard';
import { BookingsModule } from './bookings/bookings.module';
import { CatalogModule } from './catalog/catalog.module';
import { AuditModule } from './common/audit/audit.module';
import { RedisModule } from './common/cache/redis.module';
import { AppConfigModule } from './common/config/app-config.module';
import { DatabaseModule } from './common/database/database.module';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { LoggingModule } from './common/logging/logging.module';
import { RequestContextMiddleware } from './common/logging/request-context.middleware';
import { EventsModule } from './common/events/events.module';
import { OutboxModule } from './common/outbox/outbox.module';
import { RateLimitGuard } from './common/ratelimit/rate-limit.guard';
import { RateLimitModule } from './common/ratelimit/rate-limit.module';
import { CustomersModule } from './customers/customers.module';
import { DisputesModule } from './disputes/disputes.module';
import { DocumentsModule } from './documents/documents.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';
import { MatchingModule } from './matching/matching.module';
import { OpsModule } from './ops/ops.module';
import { PaymentsModule } from './payments/payments.module';
import { ProvidersModule } from './providers/providers.module';
import { BookingRequestsModule } from './requests/booking-requests.module';
import { ReviewsModule } from './reviews/reviews.module';
import { SafetyModule } from './safety/safety.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    DatabaseModule,
    RedisModule,
    AuditModule,
    OutboxModule,
    EventsModule,
    IdempotencyModule,
    RateLimitModule,
    HealthModule,
    AuthModule,
    UsersModule,
    CustomersModule,
    ProvidersModule,
    IdentityModule,
    CatalogModule,
    AddressesModule,
    BookingsModule,
    PaymentsModule,
    DisputesModule,
    DocumentsModule,
    ReviewsModule,
    BookingRequestsModule,
    MatchingModule,
    SafetyModule,
    OpsModule,
    AnalyticsModule,
  ],
  providers: [
    // Guard sırası önemlidir: oran sınırı → kimlik → rol.
    // Oran sınırı en önde olmalı ki kimlik doğrulama maliyeti abuse ile tüketilemesin.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Express 5: '*' yerine adlandırılmış joker gerekir.
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}
