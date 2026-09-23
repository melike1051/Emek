# Cloud Run (ADR-0001: modular monolith + bağımsız AI servisi; Kubernetes yok).
#
# İki servis, iki farklı maruziyet:
# - `api`: internetten erişilir (mobil istemci). App Check + Firebase Auth + RBAC
#   uygulama katmanındadır; Cloud Run seviyesinde `allUsers` invoker gerekir.
# - `ai`: **yalnızca içeriden**. Ingress internal + IAM invoker: AI servisine
#   internetten hiç erişilemez, çağrı yalnızca core API'nin kimliğiyle gelir.

resource "google_cloud_run_v2_service" "api" {
  project  = var.project_id
  name     = "${local.name_prefix}-api"
  location = var.region
  labels   = local.labels

  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    # Direct VPC egress, **tüm** trafik için. `PRIVATE_RANGES_ONLY` yeterli değil:
    # AI servisi `INGRESS_TRAFFIC_INTERNAL_ONLY` ile dağıtılıyor ve `run.app` adresi
    # public IP'ye çözülüyor — o trafik VPC'den çıkmazsa "internal" sayılmaz ve
    # reddedilir. Bunun operasyonel çözümü genelde ingress'i gevşetmek olur; yani
    # yanlış egress ayarı, güvenlik ayarını bozmaya iten bir tuzaktır.
    # İnternete çıkış (PSP çağrıları) Cloud NAT üzerinden yapılır.
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.main.id
      }
    }

    containers {
      image = var.api_image

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        # CPU yalnızca istek sırasında değil sürekli tahsis edilir: outbox yayıncısı,
        # audit doğrulaması ve retention işleri istek dışında da çalışır.
        cpu_idle = false
      }

      # Liveness: bağımlılık kontrolü **yapmaz**. Geçici bir DB arızasında container'ı
      # öldürmek durumu kötüleştirir (Faz 1 kararı).
      liveness_probe {
        http_get {
          path = "/api/v1/health/live"
        }
        initial_delay_seconds = 10
        period_seconds        = 30
        failure_threshold     = 3
      }

      # Startup: bağımlılıklarıyla birlikte hazır mı? Yeni revizyon bu kontrolü
      # geçemezse trafik almaz ve önceki revizyon hizmet vermeye devam eder.
      startup_probe {
        http_get {
          path = "/api/v1/health"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 12
        timeout_seconds       = 5
      }

      env {
        name  = "NODE_ENV"
        value = var.environment == "production" ? "production" : "staging"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "EVENT_TRANSPORT_TYPE"
        value = "pubsub"
      }
      env {
        name  = "STORAGE_PROVIDER"
        value = "gcs"
      }
      env {
        name  = "STORAGE_BUCKET"
        value = google_storage_bucket.documents.name
      }
      env {
        name  = "IDENTITY_HASH_KEY_SOURCE"
        value = "kms"
      }
      env {
        name  = "IDENTITY_KMS_KEY_NAME"
        value = data.google_kms_crypto_key_version.identity_hash.name
      }
      env {
        name  = "AUDIT_ARCHIVE_PROVIDER"
        value = "gcs"
      }
      env {
        name  = "AUDIT_ARCHIVE_BUCKET"
        value = google_storage_bucket.audit_archive.name
      }
      env {
        name  = "AUDIT_VERIFICATION_ENABLED"
        value = "true"
      }
      # Uygulamanın istediği saklama süresi, bucket'ın **kilitli** politikasının
      # garanti ettiğinden uzun olamaz: arşiv adapter'ı aşan bir talebi reddeder.
      # Bu yüzden iki değer aynı değişkenden beslenir; elle ayrışmaları mümkün değil.
      env {
        name  = "AUDIT_EXPORT_RETENTION_DAYS"
        value = tostring(var.audit_archive_retention_days)
      }
      # Aynı gerekçe: kanıt dosyalarını silen lifecycle kuralı ile uygulamanın
      # bildiği saklama süresi ayrışırsa, uygulama silinmiş nesneye referans tutar.
      env {
        name  = "SAFETY_EVIDENCE_RETENTION_DAYS"
        value = tostring(var.evidence_retention_days)
      }
      env {
        name  = "AUDIT_EXPORT_ENABLED"
        value = "true"
      }
      env {
        name  = "RETENTION_ENABLED"
        value = "true"
      }
      env {
        name  = "BIGQUERY_PROVIDER"
        value = "bigquery"
      }
      env {
        name  = "BIGQUERY_DATASET"
        value = google_bigquery_dataset.analytics.dataset_id
      }
      env {
        name  = "ANALYTICS_EXPORT_ENABLED"
        value = "true"
      }
      env {
        name  = "RECONCILIATION_ENABLED"
        value = "true"
      }
      # R-53: bu sayı `resolveClientIp`'in X-Forwarded-For zincirinin sağından kaç
      # hop atlayacağını belirler ve **asimetriktir**:
      #   - Fazla değer fail-**open**'dır: saldırgan kendi XFF ön ekini gönderip
      #     zinciri uzatır ve seçilen adres onun kontrolüne geçer — IP bazlı oran
      #     sınırı tamamen atlatılır.
      #   - Eksik değer fail-closed'dır: seçim sokete doğru kayar, sınır daralır.
      # Gerçek Cloud Run topolojisinde doğru değer ölçülmeden bilinemez (A-10), bu
      # yüzden **güvenli taraftan** başlanır. Doğrulama yordamı deployment.md §6.
      env {
        name  = "TRUSTED_PROXY_HOP_COUNT"
        value = "1"
      }
      env {
        name  = "APP_CHECK_ENABLED"
        value = "true"
      }
      env {
        name  = "APP_CHECK_PROVIDER"
        value = "firebase"
      }
      env {
        name  = "AI_SERVICE_URL"
        value = google_cloud_run_v2_service.ai.uri
      }

      dynamic "env" {
        for_each = {
          DATABASE_URL             = "database-url"
          REDIS_URL                = "redis-url"
          REDIS_CA_CERT            = "redis-ca-cert"
          IDENTITY_CALLBACK_SECRET = "identity-callback-secret"
          PAYMENT_WEBHOOK_SECRET   = "payment-webhook-secret"
          STORAGE_SIGNING_SECRET   = "storage-signing-secret"
          AI_SERVICE_API_KEY       = "ai-service-api-key"
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  # Trafik açıkça **son revizyona** verilir. Rollback, bu bloğu belirli bir
  # revizyona sabitleyerek veya `gcloud run services update-traffic` ile yapılır
  # (docs/architecture/deployment.md §rollback).
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    # İmajı **pipeline** dağıtır, Terraform değil: `var.api_image` yalnızca ilk
    # kurulumdaki başlangıç değeridir. Yok sayılmazsa bir sonraki `apply`, o anda
    # çalışan revizyonu bootstrap imajına geri döndürürdü — yani altyapı değişikliği
    # sessiz bir uygulama rollback'i olurdu.
    ignore_changes = [client, client_version, template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_service" "ai" {
  project  = var.project_id
  name     = "${local.name_prefix}-ai"
  location = var.region
  labels   = local.labels

  # İçeriden erişim: AI servisi internete hiç açılmaz.
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = var.deletion_protection

  template {
    service_account = google_service_account.ai.email

    scaling {
      min_instance_count = var.ai_min_instances
      max_instance_count = var.ai_max_instances
    }

    containers {
      image = var.ai_image

      ports {
        container_port = 8000
      }

      resources {
        limits = {
          # OR-Tools CP-SAT çözücüsü CPU'ya duyarlıdır; zaman limiti uygulamada.
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle = true
      }

      liveness_probe {
        http_get {
          path = "/api/v1/health/live"
        }
        initial_delay_seconds = 10
        period_seconds        = 30
      }

      startup_probe {
        http_get {
          path = "/api/v1/health"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 12
      }

      env {
        name  = "AI_ENVIRONMENT"
        value = var.environment == "production" ? "production" : "staging"
      }
      env {
        name = "AI_SERVICE_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.managed["ai-service-api-key"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    # Aynı gerekçe: imajı pipeline dağıtır (bkz. api servisi).
    ignore_changes = [client, client_version, template[0].containers[0].image]
  }
}

# Core API internetten erişilebilir olmalı: yetkilendirme uygulama katmanındadır
# (Firebase Auth + App Check + RBAC, ADR-0022). Cloud Run IAM burada kimlik
# doğrulaması yapmaz — mobil istemcinin Google kimliği yoktur.
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Migration **job**'u: uygulama başlangıcında migration çalıştırılmaz. Aynı imaj,
# farklı giriş noktası; ayrı bir kimlikle ve yalnızca pipeline'dan tetiklenir.
resource "google_cloud_run_v2_job" "migrate" {
  project             = var.project_id
  name                = "${local.name_prefix}-migrate"
  location            = var.region
  labels              = local.labels
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.migrator.email
      max_retries     = 0
      timeout         = "600s"

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.main.id
        }
      }

      containers {
        image   = var.api_image
        command = ["npm", "run", "migrate:deploy"]

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["database-url"].secret_id
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }
}
