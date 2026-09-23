/**
 * Pub/Sub emulator topoloji kurulumu.
 *
 * Kullanım: npx tsx services/api/scripts/setup-pubsub.ts
 *
 * İdempotent: mevcut topic/subscription varsa atlar.
 * Yalnızca PUBSUB_EMULATOR_HOST ayarlıyken çalışır.
 *
 * Topic/subscription adları `../src/common/events/event-topology.ts`'den gelir — bu
 * betik ile uygulamanın gerçekte açtığı subscription'lar (`pubsub-subscriber.service.ts`)
 * arasında isim sürüklenmesini önler.
 */
import { PubSub } from '@google-cloud/pubsub';
import {
  ALL_TOPICS,
  coreSubscriptionNameFor,
  dlqTopicFor,
} from '../src/common/events/event-topology';

function isAlreadyExistsError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 6;
}

const PROJECT_ID = process.env.GCP_PROJECT_ID ?? 'emek-local';

const TOPICS = [...ALL_TOPICS, ...ALL_TOPICS.map(dlqTopicFor)];

interface SubscriptionDef {
  name: string;
  topic: string;
  dlqTopic: string;
}

// Her domain topic'i için EventConsumerRunner'ın beklediği tek subscription
// (bkz. event-topology.ts coreSubscriptionNameFor — consumer başına değil, topic başına).
const SUBSCRIPTIONS: SubscriptionDef[] = ALL_TOPICS.map((topic) => ({
  name: coreSubscriptionNameFor(topic),
  topic,
  dlqTopic: dlqTopicFor(topic),
}));

/**
 * Topolojiyi kurar (idempotent).
 *
 * Ayrı bir fonksiyon olarak dışa açılır: Faz 14 ölçüm betiği (`perf-event-pipeline.ts`)
 * aynı topolojiyi kurmak zorundadır ve kopyalanan bir kurulum, betik ile uygulamanın
 * açtığı subscription'lar arasında isim sürüklenmesi üretirdi.
 */
export async function setupPubSubTopology(
  pubsub: PubSub,
  log: (message: string) => void = () => {},
): Promise<void> {
  // Koruma **fonksiyonun içindedir**, çağıranın içinde değil (Faz 14 review).
  // Bu fonksiyon topic, subscription ve DLQ yaratan yan etkili bir yazıcıdır:
  // ambient kimlik bilgisiyle gerçek bir GCP projesinde çalıştırılırsa topolojiyi
  // oradaki Terraform'un dışından kurar. Boş string de "emulator yok" demektir —
  // Google istemcisi onu böyle yorumlar — bu yüzden varlık değil **doluluk**
  // kontrol edilir.
  if (!process.env.PUBSUB_EMULATOR_HOST) {
    throw new Error(
      'PUBSUB_EMULATOR_HOST tanımlı ve dolu olmalı: bu yordam yalnızca emulator ' +
        'topolojisini kurar. Gerçek ortamda topolojiyi Terraform kurar (ADR-0010 §8).',
    );
  }

  // Topics
  for (const topicName of TOPICS) {
    try {
      await pubsub.createTopic(topicName);
      log(`✓ Topic oluşturuldu: ${topicName}`);
    } catch (err: unknown) {
      if (isAlreadyExistsError(err)) {
        log(`· Topic mevcut: ${topicName}`);
      } else {
        throw err;
      }
    }
  }

  // Subscriptions
  for (const sub of SUBSCRIPTIONS) {
    try {
      const topic = pubsub.topic(sub.topic);
      await topic.createSubscription(sub.name, {
        enableMessageOrdering: true,
        deadLetterPolicy: {
          deadLetterTopic: pubsub.topic(sub.dlqTopic).name,
          maxDeliveryAttempts: 10,
        },
        retryPolicy: {
          minimumBackoff: { seconds: 10 },
          maximumBackoff: { seconds: 600 },
        },
      });
      log(`✓ Subscription oluşturuldu: ${sub.name} → ${sub.topic}`);
    } catch (err: unknown) {
      if (isAlreadyExistsError(err)) {
        log(`· Subscription mevcut: ${sub.name}`);
      } else {
        throw err;
      }
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.PUBSUB_EMULATOR_HOST) {
    process.stderr.write(
      'PUBSUB_EMULATOR_HOST ayarlı değil. Bu betik yalnızca emulator ile çalışır.\n',
    );
    process.exit(1);
  }

  await setupPubSubTopology(new PubSub({ projectId: PROJECT_ID }), (message) =>
    process.stdout.write(`${message}\n`),
  );

  process.stdout.write('\nPub/Sub topolojisi hazır.\n');
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`Pub/Sub kurulumu başarısız: ${String(err)}\n`);
    process.exit(1);
  });
}
