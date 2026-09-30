# Projede açılması gereken servisler. `disable_on_destroy = false`: destroy sırasında
# API'yi kapatmak, aynı projedeki başka kaynakları da etkileyebilir.
resource "google_project_service" "required" {
  for_each = toset([
    "run.googleapis.com",
    # Admin paneli IAP arkasında (R-105).
    "iap.googleapis.com",
    "sqladmin.googleapis.com",
    "redis.googleapis.com",
    "pubsub.googleapis.com",
    "storage.googleapis.com",
    "bigquery.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "artifactregistry.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "servicenetworking.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "billingbudgets.googleapis.com",
    # Push bildirimleri (Faz 16): FCM HTTP v1.
    "fcm.googleapis.com",
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
