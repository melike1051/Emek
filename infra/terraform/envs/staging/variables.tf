variable "project_id" {
  description = "Bu ortama ait GCP projesi. Ortamlar ayrı projelerdedir."
  type        = string
}

variable "region" {
  type    = string
  default = "europe-west1"
}

variable "api_image" {
  description = "Core API imajı — digest ile pinlenmiş olmalı (etiket değil)."
  type        = string
}

variable "ai_image" {
  description = "AI servisi imajı — digest ile pinlenmiş olmalı."
  type        = string
}

variable "web_image" {
  description = "Web imajı — bu ortam için derlenmiş, digest ile pinlenmiş."
  type        = string
}

variable "admin_image" {
  description = "Operasyon paneli imajı — bu ortam için derlenmiş, digest ile pinlenmiş."
  type        = string
}

variable "admin_access_members" {
  description = "IAP ile panele erişebilecek kimlikler (ör. group:ops@...). Boşsa kimse erişemez."
  type        = list(string)
  default     = []
}

variable "alert_email" {
  type    = string
  default = ""
}

variable "billing_account" {
  type    = string
  default = ""
}

variable "github_repository" {
  description = "owner/repo — Workload Identity Federation'ın güveneceği depo."
  type        = string
  default     = ""
}

variable "web_origins" {
  description = "Kanıt bucket'ı CORS'u için web origin'leri (bkz. modül değişkeni). Web dağıtılana kadar boş."
  type        = list(string)
  default     = []
}
