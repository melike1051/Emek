# Cloud KMS — kimlik hash anahtarı (ADR-0004 §5, R-39).
#
# Anahtar **MAC** amaçlıdır (HMAC_SHA256): uygulama anahtarı okuyamaz, yalnızca
# imzalatabilir. `rotation_period` **bilinçli olarak yoktur**: ham kimlik verisi
# saklanmadığı için mevcut hash'ler yeniden hesaplanamaz; anahtar değişirse aynı
# kişi farklı hash üretir ve mükerrer hesap kontrolü sessizce bozulur.
# Göç gerekirse yol `docs/security/identity-key-migration.md`'dedir ve otomatik değildir.

resource "google_kms_key_ring" "main" {
  project  = var.project_id
  name     = "${local.name_prefix}-keyring"
  location = var.region

  depends_on = [google_project_service.required]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key" "identity_hash" {
  name     = "identity-hash"
  key_ring = google_kms_key_ring.main.id
  purpose  = "MAC"

  version_template {
    algorithm        = "HMAC_SHA256"
    protection_level = "SOFTWARE"
  }

  lifecycle {
    prevent_destroy = true
    # Rotasyon yok: bu alanların değişmesi tekilliği bozar (ADR-0004 §5).
    ignore_changes = [rotation_period]
  }
}

# Uygulamanın kullandığı **sürüm** açıkça okunur: "primary"ye bırakmak, KMS
# tarafındaki bir değişikliğin hash'leri sessizce ayırmasına izin verirdi.
data "google_kms_crypto_key_version" "identity_hash" {
  crypto_key = google_kms_crypto_key.identity_hash.id
  # Sürüm **açıkça** sabitlenir. Örtük arama ("primary") ileride ikinci bir sürüm
  # oluşturulduğunda sessizce değişebilir ve aynı kişi için farklı hash üretirdi —
  # yani rotasyonsuzluk kararı yapılandırmanın kendisinde delinirdi (ADR-0004 §5).
  version = 1
}

# Müşteri yönetimli şifreleme anahtarı (depolama ve veritabanı için).
resource "google_kms_crypto_key" "data" {
  name            = "data-encryption"
  key_ring        = google_kms_key_ring.main.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s" # 90 gün — veri anahtarı rotasyonu güvenlidir (yeniden şifreleme gerektirmez).

  lifecycle {
    prevent_destroy = true
  }
}
