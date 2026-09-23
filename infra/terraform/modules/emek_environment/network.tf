# Özel ağ: veritabanı ve Redis **hiçbir zaman** public IP almaz. Cloud Run bu ağa
# Direct VPC egress ile bağlanır (serverless connector'a gerek yok).

resource "google_compute_network" "main" {
  project                 = var.project_id
  name                    = "${local.name_prefix}-vpc"
  auto_create_subnetworks = false

  depends_on = [google_project_service.required]
}

resource "google_compute_subnetwork" "main" {
  project                  = var.project_id
  name                     = "${local.name_prefix}-subnet"
  region                   = var.region
  network                  = google_compute_network.main.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

# Cloud SQL ve Memorystore'un özel IP alacağı aralık.
resource "google_compute_global_address" "private_service_range" {
  project       = var.project_id
  name          = "${local.name_prefix}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_range.name]

  depends_on = [google_project_service.required]
}

# Cloud NAT: Cloud Run tüm trafiğini VPC üzerinden gönderdiği için (AI servisinin
# internal ingress'i bunu gerektiriyor), internete çıkış — ödeme kuruluşu ve kimlik
# sağlayıcısı çağrıları — NAT üzerinden yapılır. NAT olmadan bu çağrılar sessizce
# zaman aşımına uğrardı.
resource "google_compute_router" "main" {
  project = var.project_id
  name    = "${local.name_prefix}-router"
  region  = var.region
  network = google_compute_network.main.id
}

resource "google_compute_router_nat" "main" {
  project                            = var.project_id
  name                               = "${local.name_prefix}-nat"
  region                             = var.region
  router                             = google_compute_router.main.name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
