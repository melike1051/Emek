variable "environment" {
  description = "Ortam adı. Kaynak adlarına girer ve ortamlar arası çapraz bağlanmayı imkânsız kılar."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment yalnızca staging veya production olabilir."
  }
}

variable "project_id" {
  description = "Bu ortama **ait** GCP projesi. Staging ve production ayrı projelerdir (ADR-0023)."
  type        = string
}

variable "region" {
  description = "Tüm bölgesel kaynakların bölgesi."
  type        = string
  default     = "europe-west1"
}

variable "billing_account" {
  description = "Bütçe alarmı için faturalandırma hesabı kimliği (R-24). Boşsa bütçe kaynağı oluşturulmaz."
  type        = string
  default     = ""
}

variable "monthly_budget_amount" {
  description = "Aylık bütçe üst sınırı (para birimi: budget_currency). R-24."
  type        = number
  default     = 500
}

variable "budget_currency" {
  type    = string
  default = "EUR"
}

variable "alert_email" {
  description = "Alarm bildirim adresi. Boşsa bildirim kanalı oluşturulmaz ve alarmlar sessiz kalır."
  type        = string
  default     = ""
}

variable "api_image" {
  description = "Core API container imajı (digest ile pinlenmiş olmalı)."
  type        = string
}

variable "ai_image" {
  description = "AI servisi container imajı (digest ile pinlenmiş olmalı)."
  type        = string
}

variable "database_tier" {
  description = "Cloud SQL makine tipi."
  type        = string
  default     = "db-custom-2-7680"
}

variable "database_availability_type" {
  description = "ZONAL veya REGIONAL. Production'da REGIONAL beklenir."
  type        = string
  default     = "ZONAL"
}

variable "redis_tier" {
  type    = string
  default = "BASIC"
}

variable "redis_memory_gb" {
  type    = number
  default = 1
}

variable "api_min_instances" {
  description = <<-EOT
    Soğuk başlangıç, kimlik doğrulama ve ödeme akışlarında gecikmeye dönüşür.

    En az 1 olmak **zorundadır**: API container'ı zamanlanmış işlerini uygulama içi
    `setTimeout` döngüsüyle yürütür ve sıfıra ölçeklenen bir serviste container
    boşta kalınca kapanır — döngü de onunla ölür. `cpu_idle = false` tek başına
    yetmez; CPU'nun tahsis edileceği bir instance olmalıdır.

    Kritik olan **uzun aralıklı** işlerdir. Kısa aralıklılar (outbox 1 sn, safety
    bakımı ve analytics export 30 sn, zamanlanmış serbest bırakma 60 sn) trafik bir
    instance'ı ayakta tuttuğu sürece zaten çalışır. Ama retention süpürmesi ve audit
    zincir doğrulaması **saatlik**, ödeme mutabakatı 15 dakikalık: hiçbir ortam bu
    kadar süre kendiliğinden sıcak kalmaz. Onlar için `RETENTION_ENABLED=true`
    sıfıra ölçeklenen bir serviste yalnızca bir yanılsamadır (T-24, R-38).
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.api_min_instances >= 1
    error_message = "api_min_instances >= 1 olmalı: zamanlanmış işler uygulama içi döngülerdir ve sıfıra ölçeklenen serviste çalışmaz."
  }
}

variable "api_max_instances" {
  description = "Üst sınır maliyet koruması **ve** veritabanı bağlantı havuzu koruması (R-24)."
  type        = number
  default     = 10
}

variable "ai_min_instances" {
  type    = number
  default = 0
}

variable "ai_max_instances" {
  type    = number
  default = 5
}

variable "deletion_protection" {
  description = "Cloud SQL ve bucket'ların kazara silinmeye karşı korunması."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "Cloud Logging log bucket saklama süresi. TODO(legal): A-04 ile kesinleşecek."
  type        = number
  default     = 30
}

variable "evidence_retention_days" {
  description = <<-EOT
    Kanıt dosyalarının (before/after fotoğrafları) bucket lifecycle ile silinme süresi (R-83).

    Uygulamadaki `SAFETY_EVIDENCE_RETENTION_DAYS` ile **aynı** değeri taşımalıdır;
    ayrışırsa ya uygulama silinmiş nesneye referans tutar ya da nesne belgelenen
    süreden uzun kalır. TODO(legal): süre hukuk görüşüyle kesinleşecek (A-04).
  EOT
  type        = number
  default     = 365
}

variable "audit_archive_retention_days" {
  description = <<-EOT
    Denetim arşivi bucket'ının **kilitli** retention policy süresi (R-82).

    Kilit geri alınamaz: bu değeri düşürmek mümkün değildir ve bucket süre dolmadan
    silinemez. TODO(legal): denetim izi saklama süresi hukuk görüşüyle kesinleşecek (A-04).
  EOT
  type        = number
  default     = 3650
}

variable "analytics_table_expiration_days" {
  description = <<-EOT
    BigQuery ham event tablosundaki partition'ların yaşam süresi (R-83).

    0 = süresiz (varsayılan değildir). TODO(legal): analitik kopya için saklama
    süresi hukuk görüşüyle kesinleşecek (A-04).
  EOT
  type        = number
  default     = 730
}

variable "github_repository" {
  description = "Workload Identity Federation'ın güveneceği repository (owner/repo). Boşsa WIF kaynakları oluşturulmaz."
  type        = string
  default     = ""
}

variable "subnet_cidr" {
  type    = string
  default = "10.10.0.0/24"
}

variable "labels" {
  type    = map(string)
  default = {}
}

variable "web_origins" {
  description = <<-EOT
    Kanıt bucket'ına tarayıcıdan imzalı URL ile yükleme/okuma yapabilecek web origin'leri
    (ör. `https://app.emek.example`). Yalnızca şema + host (+ port); yol ve joker yoktur.
    Boş liste CORS kuralı yazmaz — web dağıtılana kadar tarayıcıdan yükleme kapalıdır.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for origin in var.web_origins : can(regex("^https://[a-z0-9.-]+(:[0-9]+)?$", origin))])
    error_message = "web_origins yalnızca https://host[:port] biçiminde olmalı (joker yok)."
  }
}
