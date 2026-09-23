# CI/CD kimliği — Workload Identity Federation (ADR-0023).
#
# Uzun ömürlü servis hesabı JSON anahtarı **oluşturulmaz**: böyle bir anahtar
# repository secret'ında durur, süresi dolmaz, sızdığında iz bırakmaz ve iptali
# manueldir. Yerine GitHub Actions'ın OIDC token'ı federe edilir: token isteğe
# özeldir, dakikalar içinde geçersiz olur ve yalnızca belirtilen repository +
# ref için kabul edilir.

resource "google_artifact_registry_repository" "containers" {
  project       = var.project_id
  location      = var.region
  repository_id = "emek"
  format        = "DOCKER"
  description   = "Emek container imajları"
  labels        = local.labels

  # İmajlar digest ile dağıtılır; etiket üzerine yazılması sürüm izlenebilirliğini
  # bozar (aynı etiket farklı içerik).
  docker_config {
    immutable_tags = true
  }

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool" "github" {
  count = var.github_repository == "" ? 0 : 1

  project                   = var.project_id
  workload_identity_pool_id = "${local.name_prefix}-github"
  display_name              = "GitHub Actions (${var.environment})"

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count = var.github_repository == "" ? 0 : 1

  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.ref"              = "assertion.ref"
    "attribute.workflow_ref"     = "assertion.workflow_ref"
  }

  # Kapı burada: yalnızca **bu** repository'nin, **main** dalından gelen token'ı
  # kabul edilir. Koşul olmadan herhangi bir GitHub deposu federe olabilirdi;
  # yalnızca repository koşuluyla ise repoya push yetkisi olan herkes bir feature
  # dalına `id-token: write` isteyen bir workflow ekleyip dağıtım kimliğini
  # alabilirdi (WIF, token'ı hangi workflow'un istediğini umursamaz).
  #
  # Bu **staging için de** geçerlidir: staging gerçek sırlar ve gerçek bir
  # veritabanı taşır; "yalnızca test ortamı" değildir.
  attribute_condition = join(" && ", [
    "assertion.repository == \"${var.github_repository}\"",
    "assertion.repository_owner == \"${split("/", var.github_repository)[0]}\"",
    "assertion.ref == \"refs/heads/main\"",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deployer" {
  count = var.github_repository == "" ? 0 : 1

  project      = var.project_id
  account_id   = "${local.name_prefix}-deployer"
  display_name = "Emek CI/CD deploy (${var.environment})"

  depends_on = [google_project_service.required]
}

# İkinci kapı: sağlayıcı koşulunu geçen token yalnızca `main` dalına bağlı
# principal kümesi üzerinden bu servis hesabını üstlenebilir. Sağlayıcı koşulu
# ileride gevşetilirse bu bağlama hâlâ dar kalır.
resource "google_service_account_iam_member" "deployer_workload_identity" {
  count = var.github_repository == "" ? 0 : 1

  service_account_id = google_service_account.deployer[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.ref/refs/heads/main"
}

# Deploy kimliğinin yetkileri: imaj yaz, revizyon dağıt, migration job'u çalıştır.
# Doğrudan sır okuma, veritabanı erişimi veya IAM politikası değiştirme yetkisi
# yoktur — ama bu "sırlara erişemez" demek **değildir**: `run.developer` +
# uygulama servis hesabı üzerinde `serviceAccountUser`, keyfi bir imajı o kimlikle
# çalıştırabilmek demektir ve o kimlik sırları okur. Bu, dağıtım yetkisinin
# doğasında vardır; bu yüzden asıl kapı WIF koşulunun darlığıdır (yukarıda),
# rollerin darlığı değil. (Faz 13 güvenlik review'u H-3, R-90.)
resource "google_project_iam_member" "deployer" {
  for_each = var.github_repository == "" ? toset([]) : toset([
    "roles/artifactregistry.writer",
    "roles/run.developer",
    "roles/run.invoker",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer[0].email}"
}

# Cloud Run revizyonu, uygulamanın servis hesabı olarak çalışır; bunu ayarlayabilmek
# için deploy kimliğinin o hesabı "kullanma" izni olmalıdır. Proje geneli
# `serviceAccountUser` yerine hesap bazlı verilir.
resource "google_service_account_iam_member" "deployer_act_as" {
  for_each = var.github_repository == "" ? {} : {
    api      = google_service_account.api.name
    ai       = google_service_account.ai.name
    migrator = google_service_account.migrator.name
  }

  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer[0].email}"
}
