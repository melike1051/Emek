# Cloud Storage (R-41, R-82, R-83).
#
# İki bucket, iki farklı güvenlik modeli:
# - `documents`: kanıt dosyaları. Private, imzalı URL ile erişilir, lifecycle ile silinir.
# - `audit-archive`: denetim zinciri arşivi. **Kilitli** retention policy taşır ve
#   silinemez; lifecycle kuralı **yoktur** (bir arşivi otomatik silmek, arşiv olmaz).

resource "google_storage_bucket" "documents" {
  project  = var.project_id
  name     = "${local.name_prefix}-documents"
  location = var.region
  labels   = local.labels

  # R-41: imzalı URL modeli yalnızca bucket gerçekten private ise anlamlıdır.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Yanlışlıkla üzerine yazılan bir kanıt fotoğrafı geri alınabilir olmalı.
  versioning {
    enabled = true
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.data.id
  }

  # R-83: kanıt dosyaları süresiz durmaz.
  lifecycle_rule {
    condition {
      age = var.evidence_retention_days
    }
    action {
      type = "Delete"
    }
  }

  # Eski sürümler asıl nesneden uzun yaşamamalı.
  lifecycle_rule {
    condition {
      num_newer_versions = 3
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  force_destroy = false

  depends_on = [google_kms_crypto_key_iam_member.storage_kms]
}

resource "google_storage_bucket" "audit_archive" {
  project  = var.project_id
  name     = "${local.name_prefix}-audit-archive"
  location = var.region
  labels   = local.labels

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # `documents` ile aynı CMEK: denetim arşivi de müşteri yönetimli anahtarla şifrelenir.
  encryption {
    default_kms_key_name = google_kms_crypto_key.data.id
  }

  # R-82: kilitli politika proje sahibi tarafından bile gevşetilemez veya
  # kaldırılamaz. Bu, "veritabanına tam erişimi olan saldırgan arşivi değiştiremez"
  # iddiasının dayanağıdır. **Kilit geri alınamaz.**
  retention_policy {
    is_locked        = true
    retention_period = var.audit_archive_retention_days * 24 * 60 * 60
  }

  # Nesne bazlı saklama **açılmaz**: uygulamanın rolü `objectCreator`'dır ve
  # nesne saklama süresi yazma izni (`storage.objects.setRetention`) bilinçli
  # olarak verilmemiştir — vermek, arşivi değiştirme yolunu açardı. Garanti
  # yukarıdaki kilitli bucket politikasından gelir ve her nesneye uygulanır.

  versioning {
    enabled = true
  }

  force_destroy = false

  depends_on = [google_kms_crypto_key_iam_member.storage_kms]
}

# Bucket'ların CMEK kullanabilmesi için storage servis ajanına anahtar izni.
data "google_storage_project_service_account" "gcs" {
  project    = var.project_id
  depends_on = [google_project_service.required]
}

resource "google_kms_crypto_key_iam_member" "storage_kms" {
  crypto_key_id = google_kms_crypto_key.data.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}
