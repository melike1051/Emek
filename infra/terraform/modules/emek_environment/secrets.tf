# Secret Manager (ADR-0013).
#
# Terraform yalnızca **kabı** ve erişim iznini oluşturur. Sır değerleri kodda,
# tfvars'ta veya CI değişkeninde bulunmaz; sürümler ayrı bir elden yazılır.
# İstisna: Terraform'un kendi ürettiği veritabanı parolası ve Redis AUTH dizesi —
# bunlar zaten state'te olduğu için Secret Manager'a yazmak yeni bir ifşa eklemez
# ve uygulamaya tek bir okuma yolu bırakır.

resource "google_secret_manager_secret" "managed" {
  for_each = toset(local.api_secret_ids)

  project   = var.project_id
  secret_id = "${local.name_prefix}-${each.value}"
  labels    = local.labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required]
}
