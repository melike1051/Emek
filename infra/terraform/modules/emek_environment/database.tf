# Cloud SQL for PostgreSQL + PostGIS (ADR-0003).
#
# Public IP **yoktur**: veritabanına yalnızca VPC içinden erişilir. Yedekleme ve
# point-in-time recovery açıktır; bir migration yanlış giderse geri dönüş yolu budur
# (bkz. docs/architecture/deployment.md §rollback).

resource "google_sql_database_instance" "main" {
  project             = var.project_id
  name                = "${local.name_prefix}-postgres"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.database_tier
    availability_type = var.database_availability_type
    disk_type         = "PD_SSD"
    disk_autoresize   = true
    user_labels       = local.labels

    ip_configuration {
      # Public IP kapalı: internetten erişilemez.
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.main.id
      enable_private_path_for_google_cloud_services = true
      ssl_mode                                      = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "02:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 30
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = 7 # Pazar
      hour         = 3
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = true
      # Sorgu metinleri PII taşıyabilir: istemci IP'si ve kullanıcı verisi kaydedilmez.
      record_client_address = false
    }

    database_flags {
      name  = "max_connections"
      value = "200"
    }

    # Yavaş sorgu izlenebilirliği (Faz 14 performans çalışmasının girdisi).
    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }
  }

  depends_on = [google_service_networking_connection.private_services]

  # `prevent_destroy` **kullanılmaz**: sabit olmak zorundadır ve staging'in
  # silinebilir olması gerekiyor. Koruma ortam bazlı `deletion_protection`
  # ile yapılır (production'da true) — kapsam aynı, ama ortamdan ortama ayarlanabilir.
}

resource "google_sql_database" "emek" {
  project  = var.project_id
  name     = "emek"
  instance = google_sql_database_instance.main.name
}

# Parola Terraform tarafından **üretilir** ama koda yazılmaz: Secret Manager'a
# yazılır ve Cloud Run oradan okur. State dosyası yine de hassastır — bu yüzden
# state bucket'ı şifreli ve erişimi kısıtlıdır (bkz. envs/*/backend.tf).
resource "random_password" "database" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  project  = var.project_id
  name     = "emek_app"
  instance = google_sql_database_instance.main.name
  password = random_password.database.result
}

# Tam bağlantı dizesi sır olarak yazılır: uygulama ve migration job'u aynı yerden
# okur, kimlik bilgisi hiçbir servis tanımında görünmez.
resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.managed["database-url"].id
  # `sslmode=require`: instance `ssl_mode = ENCRYPTED_ONLY` ile yapılandırıldı;
  # şifrelenmemiş bağlantı reddedilir ve dizgede bu olmadan istemci düz bağlantı
  # dener. TODO(verify): `verify-ca`'ya geçmek için sunucu CA'sının istemciye
  # dağıtılması gerekir (Faz 14).
  secret_data = format(
    "postgres://%s:%s@%s:5432/%s?sslmode=require",
    google_sql_user.app.name,
    urlencode(random_password.database.result),
    google_sql_database_instance.main.private_ip_address,
    google_sql_database.emek.name,
  )
}

# PostGIS extension'ı migration ile kurulur (ADR-0014): şema değişiklikleri tek
# bir yerden, sürümlü olarak gelir. Terraform burada yalnızca veritabanını yaratır.
