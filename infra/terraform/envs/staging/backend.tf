terraform {
  required_version = ">= 1.9.0"

  # State **repository'de değildir**: veritabanı parolası ve Redis AUTH dizesi
  # gibi üretilmiş sırlar state'te bulunur. Bucket ayrı bir yönetim projesinde,
  # versiyonlu ve erişimi kısıtlı olmalıdır.
  #
  # Kısmi yapılandırma: bucket adı kodda sabit değildir.
  #   terraform init -backend-config=backend.hcl
  backend "gcs" {
    prefix = "emek/staging"
  }
}
