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

  # Ön uçlar (R-105): imajlar ortama özel derlenir; panel IAP arkasında.
  web_image            = var.web_image
  admin_image          = var.admin_image
  admin_access_members = var.admin_access_members

  # Küçük ve ucuz: staging yük testi ortamı değildir (Faz 14).
  database_tier              = "db-custom-1-3840"
  database_availability_type = "ZONAL"
  redis_tier                 = "BASIC"
  redis_memory_gb            = 1

  # `api_min_instances = 0` **olamaz** (modüldeki validation da reddeder): saatlik
  # işler — retention süpürmesi ve audit zincir doğrulaması — uygulama içi
  # `setTimeout` döngüleridir ve sıfıra ölçeklenen bir serviste container boşta
  # kalınca kapanır. Kısa aralıklı işçiler (outbox 1 sn, safety 30 sn) trafik varken
  # zaten çalışır; saatlik olanlar için hiçbir ortam o kadar sıcak kalmaz.
  #
  # Bunun bedeli sürekli açık bir instance (~$50/ay, bu ortamın bütçesinin üçte
  # biri) ve bilinçli kabul edilmiştir: staging'in amacı production ile **aynı** kod
  # yollarını çalıştırmaksa (bu dosyanın başı), retention'ın ilk kez production'da
  # canlı veri üzerinde çalışması kabul edilemez. Daha ucuz yollar (staging'e özel
  # kısa aralık, veya /ops uçlarına Cloud Scheduler) yapılandırma farkı yaratacağı
  # için reddedildi.
  api_min_instances = 1
  api_max_instances = 3

  # AI servisi istek-yanıt; zamanlanmış işi yoktur, sıfıra ölçeklenebilir.
  ai_min_instances = 0
  ai_max_instances = 2

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

  web_origins = var.web_origins

  subnet_cidr = "10.10.0.0/24"
}
