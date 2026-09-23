# İzleme ve alarm.
#
# İlke: **yalnızca gerçekten ölçülen** sinyaller. Uygulama bugün özel metrik
# yayınlamıyor (Faz 14 kapsamı); bu yüzden alarmlar Cloud Run/Cloud SQL/Memorystore/
# Pub/Sub'ın kendi metriklerine ve **log tabanlı** metriklere dayanır. Var olmayan bir
# metriğe alarm kurmak, hiç çalmayan bir alarm demektir.
#
# Eşikler: proje belgelerinde tanımlı bir SLO yok. Aşağıdaki değerler **varsayımdır**
# (A-09, docs/research/technical-risks.md) ve ilk gerçek trafikten sonra
# ayarlanmak üzere işaretlenmiştir.

resource "google_monitoring_notification_channel" "email" {
  count = var.alert_email == "" ? 0 : 1

  project      = var.project_id
  display_name = "Emek ${var.environment} — e-posta"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }

  depends_on = [google_project_service.required]
}

locals {
  notification_channels = var.alert_email == "" ? [] : [google_monitoring_notification_channel.email[0].id]
}

# --- Log tabanlı metrikler: uygulamanın gerçekten yazdığı loglardan ---

# Panik akışı (ADR-0008): deterministik ve anlık. Bir panik olayı operasyon için
# her zaman görünür olmalıdır — bu bir "hata" alarmı değil, olay bildirimidir.
resource "google_logging_metric" "safety_panic" {
  project = var.project_id
  name    = "${local.name_prefix}-safety-panic"
  filter  = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${local.name_prefix}-api"
    jsonPayload.event="safety.panic"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# Mutabakat farkı (ADR-0021): para hareketi ile kayıt arasında tutarsızlık.
# Otomatik düzeltme yoktur ve olmamalıdır; bu yüzden insan görmek zorundadır.
resource "google_logging_metric" "reconciliation_discrepancy" {
  project = var.project_id
  name    = "${local.name_prefix}-reconciliation-discrepancy"
  filter  = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${local.name_prefix}-api"
    jsonPayload.event="reconciliation.discrepancy"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# Audit zinciri kopukluğu (ADR-0013 §8). Zincir tamper-evident'tır: kopukluk ancak
# doğrulama işi baktığında görünür. Görüldüğünde sessiz kalmamalıdır.
resource "google_logging_metric" "audit_chain_broken" {
  project = var.project_id
  name    = "${local.name_prefix}-audit-chain-broken"
  filter  = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${local.name_prefix}-api"
    jsonPayload.event="audit.chain_broken"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# Consumer/worker hataları: DLQ'ya düşmeden önceki kalıcı hata sinyali.
resource "google_logging_metric" "worker_failure" {
  project = var.project_id
  name    = "${local.name_prefix}-worker-failure"
  filter  = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${local.name_prefix}-api"
    severity>=ERROR
    jsonPayload.event=~"^(outbox|consumer|dead_letter)\\."
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# --- Alarm politikaları ---

# Cloud Run 5xx oranı. Varsayım (A-09): 5 dakikada 10'dan fazla 5xx, müşteri
# akışlarının bozulduğu anlamına gelir.
resource "google_monitoring_alert_policy" "api_server_errors" {
  project      = var.project_id
  display_name = "Emek ${var.environment} — core API 5xx"
  combiner     = "OR"

  conditions {
    display_name = "5xx sayısı > 10 / 5dk"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type=\"cloud_run_revision\"",
        "resource.labels.service_name=\"${local.name_prefix}-api\"",
        "metric.type=\"run.googleapis.com/request_count\"",
        "metric.labels.response_code_class=\"5xx\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = local.notification_channels
}

# Gecikme. Varsayım (A-09): p95 > 2 sn, 10 dk boyunca. Gerçek SLO Faz 14'te
# ölçülecek ve bu eşik oradan gelecek.
resource "google_monitoring_alert_policy" "api_latency" {
  project      = var.project_id
  display_name = "Emek ${var.environment} — core API p95 gecikme"
  combiner     = "OR"

  conditions {
    display_name = "p95 > 2000ms / 10dk"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type=\"cloud_run_revision\"",
        "resource.labels.service_name=\"${local.name_prefix}-api\"",
        "metric.type=\"run.googleapis.com/request_latencies\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 2000
      duration        = "600s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_PERCENTILE_95"
      }
    }
  }

  notification_channels = local.notification_channels
}

# Uygunluk: dışarıdan, düzenli aralıkla. Cloud Run metrikleri yalnızca **gelen**
# istekleri görür; hiç istek gelmiyorsa "her şey yolunda" gibi görünür.
resource "google_monitoring_uptime_check_config" "api" {
  project      = var.project_id
  display_name = "Emek ${var.environment} — core API health"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = "/api/v1/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = replace(replace(google_cloud_run_v2_service.api.uri, "https://", ""), "/", "")
    }
  }
}

resource "google_monitoring_alert_policy" "api_uptime" {
  project      = var.project_id
  display_name = "Emek ${var.environment} — core API erişilemiyor"
  combiner     = "OR"

  conditions {
    display_name = "uptime check başarısız"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type=\"uptime_url\"",
        "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\"",
        "metric.labels.check_id=\"${google_monitoring_uptime_check_config.api.uptime_check_id}\"",
      ])
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_FRACTION_TRUE"
      }
    }
  }

  notification_channels = local.notification_channels
}

# Cloud SQL: bağlantı doygunluğu ve CPU. Havuz üst sınırı (max_connections=200)
# aşılmaya başladığında uygulama bağlantı alamaz ve her istek düşer.
resource "google_monitoring_alert_policy" "database_connections" {
  project      = var.project_id
  display_name = "Emek ${var.environment} — Cloud SQL bağlantı doygunluğu"
  combiner     = "OR"

  conditions {
    display_name = "bağlantı sayısı > 160 (max 200)"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type=\"cloudsql_database\"",
        "resource.labels.database_id=\"${var.project_id}:${google_sql_database_instance.main.name}\"",
        "metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 160
      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = local.notification_channels
}

resource "google_monitoring_alert_policy" "database_up" {
  project      = var.project_id
  display_name = "Emek ${var.environment} — Cloud SQL erişilemiyor"
  combiner     = "OR"

  conditions {
    display_name = "instance up != 1"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type=\"cloudsql_database\"",
        "resource.labels.database_id=\"${var.project_id}:${google_sql_database_instance.main.name}\"",
        "metric.type=\"cloudsql.googleapis.com/database/up\"",
      ])
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = local.notification_channels
}

# Memorystore: Redis kaybı uygulamayı düşürmez ama oran sınırlarını fail-closed'a
# düşürür — yani kullanıcılar 429 görmeye başlar.
resource "google_monitoring_alert_policy" "redis_unavailable" {
  project      = var.project_id
  display_name = "Emek ${var.environment} — Redis erişilemiyor"
  combiner     = "OR"

  conditions {
    display_name = "clients.blocked veya instance down"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type=\"redis_instance\"",
        "resource.labels.instance_id=\"${google_redis_instance.main.name}\"",
        "metric.type=\"redis.googleapis.com/stats/connections/total\"",
      ])
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "600s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = local.notification_channels
}

# Pub/Sub birikimi: consumer duruyorsa veya yetişemiyorsa en eski mesajın yaşı büyür.
# Varsayım (A-09): 10 dakikadan eski bir mesaj, teslim sorunudur.
resource "google_monitoring_alert_policy" "pubsub_backlog" {
  project      = var.project_id
  display_name = "Emek ${var.environment} — Pub/Sub teslim gecikmesi"
  combiner     = "OR"

  conditions {
    display_name = "en eski onaylanmamış mesaj > 600s"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type=\"pubsub_subscription\"",
        "metric.type=\"pubsub.googleapis.com/subscription/oldest_unacked_message_age\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 600
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["resource.label.subscription_id"]
      }
    }
  }

  notification_channels = local.notification_channels
}

# DLQ'ya düşen her mesaj bir insanın bakması gereken kalıcı hatadır (R-55).
resource "google_monitoring_alert_policy" "dead_letter" {
  project      = var.project_id
  display_name = "Emek ${var.environment} — DLQ mesajı"
  combiner     = "OR"

  conditions {
    display_name = "DLQ topic'ine mesaj yayınlandı"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type=\"pubsub_topic\"",
        "metric.type=\"pubsub.googleapis.com/topic/send_message_operation_count\"",
        "resource.label.topic_id=monitoring.regex.full_match(\".*\\\\.dlq\")",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = local.notification_channels
}

# --- Log tabanlı metriklerin alarmları ---

locals {
  log_metric_alerts = {
    audit_chain_broken = {
      metric       = google_logging_metric.audit_chain_broken.name
      display_name = "audit zinciri kopukluğu"
    }
    reconciliation_discrepancy = {
      metric       = google_logging_metric.reconciliation_discrepancy.name
      display_name = "ödeme mutabakat farkı"
    }
    safety_panic = {
      metric       = google_logging_metric.safety_panic.name
      display_name = "panik olayı"
    }
    worker_failure = {
      metric       = google_logging_metric.worker_failure.name
      display_name = "worker/consumer hatası"
    }
  }
}

resource "google_monitoring_alert_policy" "log_based" {
  for_each = local.log_metric_alerts

  project      = var.project_id
  display_name = "Emek ${var.environment} — ${each.value.display_name}"
  combiner     = "OR"

  conditions {
    display_name = each.value.display_name

    condition_threshold {
      filter = join(" AND ", [
        "resource.type=\"cloud_run_revision\"",
        "metric.type=\"logging.googleapis.com/user/${each.value.metric}\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = local.notification_channels
}

# --- Maliyet (R-24) ---
#
# Bütçe **alarmı**dır, kota değil: harcamayı durdurmaz. Gerçek kısıt Cloud Run
# `max_instance_count` ve BigQuery partition ömrüdür.
resource "google_billing_budget" "monthly" {
  count = var.billing_account == "" ? 0 : 1

  billing_account = var.billing_account
  display_name    = "Emek ${var.environment} aylık bütçe"

  budget_filter {
    projects = ["projects/${data.google_project.current.number}"]
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.monthly_budget_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.5, 0.8, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }

  dynamic "all_updates_rule" {
    for_each = local.notification_channels
    content {
      monitoring_notification_channels = local.notification_channels
    }
  }
}
