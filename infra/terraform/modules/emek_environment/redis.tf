# Memorystore Redis (cache, rate limit, distributed lock, idempotency hızlı yolu).
#
# Redis **doğruluğun kaynağı değildir** (ADR-0003): kaybı uygulamayı düşürmez,
# yavaşlatır. Bu yüzden staging'de BASIC katman yeterlidir; production'da
# STANDARD_HA seçilir çünkü kaybı tüm oran sınırlarını fail-closed'a düşürür.

resource "google_redis_instance" "main" {
  project            = var.project_id
  name               = "${local.name_prefix}-redis"
  region             = var.region
  tier               = var.redis_tier
  memory_size_gb     = var.redis_memory_gb
  authorized_network = google_compute_network.main.id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  redis_version      = "REDIS_7_2"
  labels             = local.labels

  # AUTH ve aktarım şifrelemesi: ağ izolasyonu tek savunma katmanı olmamalı.
  auth_enabled            = true
  transit_encryption_mode = "SERVER_AUTHENTICATION"

  maintenance_policy {
    weekly_maintenance_window {
      day = "SUNDAY"
      start_time {
        hours = 3
      }
    }
  }

  depends_on = [google_service_networking_connection.private_services]
}

# `rediss://` — aktarım şifrelemesi açık olduğu için TLS şeması zorunludur.
# Memorystore `SERVER_AUTHENTICATION` modunda **kendi** CA'sıyla imzalanmış bir
# sertifika sunar; bu CA public güven deposunda yoktur. İstemciye verilmezse
# `rediss://` el sıkışması doğrulamada düşer ve servis hiç hazır olmaz.
resource "google_secret_manager_secret_version" "redis_ca_cert" {
  secret      = google_secret_manager_secret.managed["redis-ca-cert"].id
  secret_data = google_redis_instance.main.server_ca_certs[0].cert
}

resource "google_secret_manager_secret_version" "redis_url" {
  secret = google_secret_manager_secret.managed["redis-url"].id
  secret_data = format(
    "rediss://:%s@%s:%d",
    urlencode(google_redis_instance.main.auth_string),
    google_redis_instance.main.host,
    google_redis_instance.main.port,
  )
}
