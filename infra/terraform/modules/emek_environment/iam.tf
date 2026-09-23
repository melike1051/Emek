# Servis hesapları ve **en az yetki** (ADR-0013 "deny by default").
#
# İlke: her servisin kendi kimliği vardır ve yalnızca gerçekten kullandığı kaynağa
# erişir. Özellikle:
# - Core API arşiv bucket'ına **objectCreator**'dır, objectAdmin değil: kod yanlış
#   olsa bile denetim arşivini silemez (R-82).
# - AI servisi hiçbir veri kaynağına erişmez; yalnızca çalışır ve log yazar.
# - Deploy kimliği (WIF) uygulama sırlarını **okuyamaz**.

resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "${local.name_prefix}-api"
  display_name = "Emek core API (${var.environment})"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "ai" {
  project      = var.project_id
  account_id   = "${local.name_prefix}-ai"
  display_name = "Emek AI service (${var.environment})"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "migrator" {
  project      = var.project_id
  account_id   = "${local.name_prefix}-migrator"
  display_name = "Emek migration job (${var.environment})"

  depends_on = [google_project_service.required]
}

# --- Core API ---

resource "google_project_iam_member" "api_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_metrics" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/cloudtrace.agent",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.api.email}"
}

# Kimlik hash'i: yalnızca **imzalatma**. `viewer` bile verilmez — anahtar materyali
# hiçbir çağrıyla dışarı çıkmamalı (R-39).
resource "google_kms_crypto_key_iam_member" "api_identity_signer" {
  crypto_key_id = google_kms_crypto_key.identity_hash.id
  role          = "roles/cloudkms.signerVerifier"
  member        = "serviceAccount:${google_service_account.api.email}"
}

resource "google_storage_bucket_iam_member" "api_documents" {
  bucket = google_storage_bucket.documents.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

# Arşive **yalnızca yazma**: silme, güncelleme veya saklama süresi değiştirme
# izni yoktur (R-82). Kod yanlış olsa bile arşiv değiştirilemez.
resource "google_storage_bucket_iam_member" "api_audit_archive" {
  bucket = google_storage_bucket.audit_archive.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.api.email}"
}

# Uygulama başlatmada bucket **yapılandırmasını** okur (uniform access, public
# access prevention, kilitli retention policy). Bu `storage.buckets.get` ister ve
# `objectAdmin`/`objectCreator` bunu **içermez** — rol verilmezse boot 403 ile
# düşerdi. Hazır roller (`legacyBucketReader`) nesne listelemeyi de getirdiği için
# tam olarak gereken izni veren özel bir rol tanımlanır.
resource "google_project_iam_custom_role" "bucket_config_reader" {
  project     = var.project_id
  role_id     = "emek${title(var.environment)}BucketConfigReader"
  title       = "Emek bucket yapılandırma okuyucu (${var.environment})"
  description = "Yalnızca bucket metadata'sı: başlatmada güvenlik yapılandırmasını doğrulamak için."
  permissions = ["storage.buckets.get"]
}

resource "google_storage_bucket_iam_member" "api_bucket_config" {
  for_each = {
    documents     = google_storage_bucket.documents.name
    audit_archive = google_storage_bucket.audit_archive.name
  }

  bucket = each.value
  role   = google_project_iam_custom_role.bucket_config_reader.id
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_kms_crypto_key_iam_member" "api_data_key" {
  crypto_key_id = google_kms_crypto_key.data.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.api.email}"
}

# V4 imzalı URL: servis hesabı **kendi adına** imzalar. Uzun ömürlü JSON anahtar
# üretilmemesinin karşılığı budur (ADR-0023).
resource "google_service_account_iam_member" "api_self_signer" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.api.email}"
}

resource "google_pubsub_topic_iam_member" "api_publisher" {
  for_each = google_pubsub_topic.domain

  project = var.project_id
  topic   = each.value.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_pubsub_subscription_iam_member" "api_subscriber" {
  for_each = google_pubsub_subscription.core_api

  project      = var.project_id
  subscription = each.value.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.api.email}"
}

# Analytics: yalnızca **ekleme**. `dataEditor` tablo silme de verirdi.
resource "google_bigquery_table_iam_member" "api_raw_events" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  table_id   = google_bigquery_table.raw_events.table_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_bigquery_jobs" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_secrets" {
  for_each = google_secret_manager_secret.managed

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

# --- AI servisi ---
# Veri kaynağı yok: AI servisi durumsuzdur ve yalnızca core API'den çağrılır.

resource "google_project_iam_member" "ai_observability" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.ai.email}"
}

resource "google_secret_manager_secret_iam_member" "ai_service_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.managed["ai-service-api-key"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ai.email}"
}

# Yalnızca core API'nin AI servisini çağırabilmesi (ingress internal + IAM).
resource "google_cloud_run_v2_service_iam_member" "ai_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.ai.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.api.email}"
}

# --- Migration job ---

resource "google_project_iam_member" "migrator_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.migrator.email}"
}

resource "google_project_iam_member" "migrator_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.migrator.email}"
}

resource "google_secret_manager_secret_iam_member" "migrator_database_url" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.managed["database-url"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.migrator.email}"
}
