# Pub/Sub topolojisi (ADR-0010 §8, ADR-0020).
#
# Topic başına **tek** subscription: `EventConsumerRunner` event type'a göre kayıtlı
# tüm consumer'lara kendi içinde dispatch eder. Consumer başına ayrı subscription
# açmak aynı event'i birden çok kez teslim ederdi.
#
# Adlandırma `services/api/src/common/events/event-topology.ts` ile aynıdır; uygulama
# beklediği subscription'ların varlığını boot'ta doğrular (yoksa ayağa kalkmaz).

resource "google_pubsub_topic" "domain" {
  for_each = toset(local.event_topics)

  project = var.project_id
  name    = each.value
  labels  = local.labels

  message_retention_duration = "604800s" # 7 gün

  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic" "dlq" {
  for_each = toset(local.event_topics)

  project = var.project_id
  name    = "${each.value}.dlq"
  labels  = local.labels

  # DLQ mesajları incelenene kadar durmalı: 7 gün Pub/Sub'ın üst sınırıdır.
  message_retention_duration = "604800s"

  depends_on = [google_project_service.required]
}

resource "google_pubsub_subscription" "core_api" {
  for_each = toset(local.event_topics)

  project = var.project_id
  name    = "${each.value}.core-api"
  topic   = google_pubsub_topic.domain[each.value].id
  labels  = local.labels

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  enable_message_ordering    = true

  # Kalıcı hata sonsuza kadar yeniden denenmez (R-55): 10 denemeden sonra DLQ.
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq[each.value].id
    max_delivery_attempts = 10
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# DLQ'nun çalışabilmesi için Pub/Sub servis ajanının subscription'dan nack alıp
# DLQ topic'ine yazma izni olmalı.
data "google_project" "current" {
  project_id = var.project_id
}

locals {
  pubsub_service_agent = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  for_each = google_pubsub_topic.dlq

  project = var.project_id
  topic   = each.value.name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_service_agent
}

resource "google_pubsub_subscription_iam_member" "dlq_subscriber" {
  for_each = google_pubsub_subscription.core_api

  project      = var.project_id
  subscription = each.value.name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}
