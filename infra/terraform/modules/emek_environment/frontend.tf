# Web ve operasyon (admin) uygulamaları (Faz 17, R-105; ADR-0024, ADR-0026).
#
# İki servis, iki farklı maruziyet:
# - `web`: müşteri/sağlayıcı arayüzü, internete açık (`allUsers` invoker). Kimlik ve yetki
#   core API'dedir; web yalnız aynı-origin proxy + sayfa sunucusudur.
# - `admin`: operasyon paneli, **IAP arkasında**. Google hesabıyla kimliği doğrulanmamış ve
#   `admin_access_members` listesinde olmayan hiç kimse sayfaya ulaşamaz. Uygulama içi RBAC
#   (ADMIN/SUPPORT) ikinci katmandır, tek kapı değildir.
#
# İkisi de API'ye `API_ORIGIN` üzerinden (Cloud Run adresi) konuşur ve tarayıcı adresini
# `WEB_PROXY_SECRET` ile doğrulanan başlıkla iletir (R-107). İmajlar ortama özeldir
# (`NEXT_PUBLIC_*` derleme anında gömülür, infra/docker/Dockerfile.frontend).

resource "google_service_account" "web" {
  project      = var.project_id
  account_id   = "${local.name_prefix}-web"
  display_name = "Emek web (${var.environment})"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "admin" {
  project      = var.project_id
  account_id   = "${local.name_prefix}-admin"
  display_name = "Emek admin (${var.environment})"

  depends_on = [google_project_service.required]
}

# Ön uç servis hesaplarının tek yetkisi proxy sırrını okumaktır: veritabanı, bucket, KMS yok.
resource "google_secret_manager_secret_iam_member" "frontend_proxy_secret" {
  for_each = {
    web   = google_service_account.web.email
    admin = google_service_account.admin.email
  }

  project   = var.project_id
  secret_id = google_secret_manager_secret.managed["web-proxy-secret"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value}"
}

locals {
  # Doğrudan Cloud Run adresine gelen tarayıcı trafiğinde ön uç zincire tek girdi ekler.
  # Önüne yük dengeleyici konursa 2 olur; gerçek dağıtımda ölçülür (deployment.md §6).
  frontend_client_ip_hop_count = "1"

  frontends = {
    web = {
      image         = var.web_image
      account       = google_service_account.web.email
      max_instances = var.web_max_instances
    }
    admin = {
      image         = var.admin_image
      account       = google_service_account.admin.email
      max_instances = var.admin_max_instances
    }
  }

}

# IAP servis ajanı API açılınca hemen var olmayabilir; açıkça oluşturulur, yoksa yeni bir
# projede aşağıdaki invoker bağlaması "service account does not exist" ile düşer.
resource "google_project_service_identity" "iap" {
  provider = google-beta
  project  = var.project_id
  service  = "iap.googleapis.com"

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service" "frontend" {
  for_each = local.frontends

  # `iap_enabled` (Cloud Run'da doğrudan IAP, yük dengeleyicisiz) yalnız google-beta'da.
  provider = google-beta

  project  = var.project_id
  name     = "${local.name_prefix}-${each.key}"
  location = var.region
  labels   = local.labels

  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection
  launch_stage        = each.key == "admin" ? "BETA" : null
  iap_enabled         = each.key == "admin"

  template {
    service_account = each.value.account

    # Durumsuz sayfa sunucusu: zamanlanmış işi yoktur, sıfıra ölçeklenir.
    scaling {
      min_instance_count = 0
      max_instance_count = each.value.max_instances
    }

    containers {
      image = each.value.image

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      startup_probe {
        http_get {
          path = "/giris"
        }
        initial_delay_seconds = 2
        period_seconds        = 5
        failure_threshold     = 12
      }

      env {
        name  = "API_ORIGIN"
        value = google_cloud_run_v2_service.api.uri
      }
      env {
        name  = "CLIENT_IP_HOP_COUNT"
        value = local.frontend_client_ip_hop_count
      }
      env {
        name = "WEB_PROXY_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.managed["web-proxy-secret"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    # İmajı dağıtım hattı yönetir (API ile aynı gerekçe). `launch_stage`: gcloud dağıtımı onu
    # kendi değeriyle raporlayabilir; sürekli fark üretmesin.
    ignore_changes = [client, client_version, launch_stage, template[0].containers[0].image]
  }

  depends_on = [google_secret_manager_secret_iam_member.frontend_proxy_secret]
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.frontend["web"].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Admin: `allUsers` **yok**. Cloud Run'ı yalnız IAP'ın servis ajanı çağırabilir; IAP da yalnız
# `admin_access_members`'ı geçirir. Liste boşsa panele kimse ulaşamaz (deny by default).
resource "google_cloud_run_v2_service_iam_member" "admin_iap_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.frontend["admin"].name
  role     = "roles/run.invoker"
  member   = google_project_service_identity.iap.member
}

resource "google_iap_web_cloud_run_service_iam_member" "admin_access" {
  for_each = toset(var.admin_access_members)

  provider               = google-beta
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.frontend["admin"].name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = each.value
}
