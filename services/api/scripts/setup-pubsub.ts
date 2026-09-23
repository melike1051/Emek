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

async function main(): Promise<void> {
  if (!process.env.PUBSUB_EMULATOR_HOST) {
    process.stderr.write(
      'PUBSUB_EMULATOR_HOST ayarlı değil. Bu betik yalnızca emulator ile çalışır.\n',
    );
    process.exit(1);
  }

  const pubsub = new PubSub({ projectId: PROJECT_ID });

  // Topics
  for (const topicName of TOPICS) {
    try {
      await pubsub.createTopic(topicName);
      process.stdout.write(`✓ Topic oluşturuldu: ${topicName}\n`);
    } catch (err: unknown) {
      if (isAlreadyExistsError(err)) {
        process.stdout.write(`· Topic mevcut: ${topicName}\n`);
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
      process.stdout.write(`✓ Subscription oluşturuldu: ${sub.name} → ${sub.topic}\n`);
    } catch (err: unknown) {
      if (isAlreadyExistsError(err)) {
        process.stdout.write(`· Subscription mevcut: ${sub.name}\n`);
      } else {
        throw err;
      }
    }
  }

  process.stdout.write('\nPub/Sub topolojisi hazır.\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`Pub/Sub kurulumu başarısız: ${String(err)}\n`);
  process.exit(1);
});
