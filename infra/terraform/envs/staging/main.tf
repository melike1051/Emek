# Staging ortamı.
#
# Amaç: production ile **aynı kod yollarını** çalıştırmak. Bu yüzden sağlayıcılar
# gerçektir (KMS, GCS, Pub/Sub, BigQuery); farklı olan yalnızca boyut ve
# koruma seviyesidir. Sahte sağlayıcılarla çalışan bir staging, production'a
# çıkmadan önce hiçbir şeyi kanıtlamaz.

module "emek" {
  source = "../../modules/emek_environment"

  environment = "staging"
  project_id  = var.project_id
  region      = var.region

  api_image = var.api_image
  ai_image  = var.ai_image

  # Küçük ve ucuz: staging yük testi ortamı değildir (Faz 14).
  database_tier              = "db-custom-1-3840"
  database_availability_type = "ZONAL"
  redis_tier                 = "BASIC"
  redis_memory_gb            = 1

  api_min_instances = 0
  api_max_instances = 3
  ai_min_instances  = 0
  ai_max_instances  = 2

  # Staging verisi yeniden üretilebilir; ortamı silebilmek istenir.
  deletion_protection = false

  # Kilitli retention **staging'de de** gerçektir ama kısa tutulur: kilit geri
  # alınamaz ve 10 yıllık bir test bucket'ı kalıcı maliyet demektir.
  audit_archive_retention_days = 30
  evidence_retention_days      = 30

  analytics_table_expiration_days = 90

  alert_email       = var.alert_email
  billing_account   = var.billing_account
  github_repository = var.github_repository

  monthly_budget_amount = 150

  subnet_cidr = "10.10.0.0/24"
}
