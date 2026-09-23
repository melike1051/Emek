# Production ortamı.
#
# Staging'den farkları bilinçlidir: bölgesel yüksek erişilebilirlik, silme
# koruması, gerçek saklama süreleri ve daha yüksek örnek tavanı.

module "emek" {
  source = "../../modules/emek_environment"

  environment = "production"
  project_id  = var.project_id
  region      = var.region

  api_image = var.api_image
  ai_image  = var.ai_image

  database_tier              = "db-custom-2-7680"
  database_availability_type = "REGIONAL"
  redis_tier                 = "STANDARD_HA"
  redis_memory_gb            = 2

  # Soğuk başlangıç kimlik doğrulama ve ödeme akışlarında gecikmeye dönüşür.
  api_min_instances = 1
  api_max_instances = 20
  ai_min_instances  = 1
  ai_max_instances  = 10

  deletion_protection = true

  # TODO(legal): bu süreler hukuk görüşüyle kesinleşecek (A-04). Denetim arşivi
  # kilidi **geri alınamaz** — değer kesinleşmeden production'a apply edilmemeli.
  audit_archive_retention_days    = 3650
  evidence_retention_days         = 365
  analytics_table_expiration_days = 730

  alert_email       = var.alert_email
  billing_account   = var.billing_account
  github_repository = var.github_repository

  monthly_budget_amount = 1000

  # Staging ile çakışmayan aralık: iki ortamın ağları hiçbir koşulda peer edilmez,
  # ama çakışan CIDR ileride yanlışlıkla mümkün kılınan bir bağlantıyı da bozar.
  subnet_cidr = "10.20.0.0/24"
}
