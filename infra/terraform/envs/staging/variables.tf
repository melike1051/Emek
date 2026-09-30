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
