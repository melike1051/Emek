import { PubSub } from '@google-cloud/pubsub';
import type { Provider } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

export const PUBSUB_CLIENT = Symbol('PUBSUB_CLIENT');

/**
 * Pub/Sub transport'un devrede olup olmadığı (ADR-0010, ADR-0020).
 *
 * Emulator host tanımlıysa (yerel geliştirme) veya `EVENT_TRANSPORT_TYPE=pubsub` ise
 * (production) Pub/Sub kullanılır; aksi halde `LoggingEventTransport` ile yalnızca loglanır
 * ve hiçbir consumer çalıştırılmaz (bkz. `pubsub-subscriber.service.ts`).
 */
export function usesPubSub(config: AppConfigService): boolean {
  return (
    config.env.PUBSUB_EMULATOR_HOST !== undefined || config.env.EVENT_TRANSPORT_TYPE === 'pubsub'
  );
}

/**
 * Tek bir `PubSub` client'ı hem producer (`PubSubEventTransport`) hem consumer
 * (`PubSubSubscriberService`) tarafından paylaşılır — iki ayrı GCP bağlantısı açmamak için.
 * Pub/Sub devre dışıysa `null` döner; enjekte eden servisler bunu kontrol eder.
 */
export const pubSubClientProvider: Provider = {
  provide: PUBSUB_CLIENT,
  useFactory: (config: AppConfigService): PubSub | null => {
    if (!usesPubSub(config)) {
      return null;
    }
    return new PubSub({ projectId: config.env.PUBSUB_PROJECT_ID ?? config.env.GCP_PROJECT_ID });
  },
  inject: [AppConfigService],
};
