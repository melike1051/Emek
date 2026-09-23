output "api_url" {
  description = "Core API'nin Cloud Run adresi — smoke testleri buraya bakar."
  value       = google_cloud_run_v2_service.api.uri
}

output "ai_url" {
  description = "AI servisinin adresi. İçeriden erişilir; smoke testi core API üzerinden doğrular."
  value       = google_cloud_run_v2_service.ai.uri
}

output "api_service_name" {
  value = google_cloud_run_v2_service.api.name
}

output "ai_service_name" {
  value = google_cloud_run_v2_service.ai.name
}

output "migrate_job_name" {
  value = google_cloud_run_v2_job.migrate.name
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}"
}

output "identity_kms_key_version" {
  description = "Uygulamanın IDENTITY_KMS_KEY_NAME olarak kullandığı tam sürüm adı."
  value       = data.google_kms_crypto_key_version.identity_hash.name
}

output "documents_bucket" {
  value = google_storage_bucket.documents.name
}

output "audit_archive_bucket" {
  value = google_storage_bucket.audit_archive.name
}

output "workload_identity_provider" {
  description = "GitHub Actions'ın kullanacağı sağlayıcı kaynak adı (WIF)."
  value       = var.github_repository == "" ? "" : google_iam_workload_identity_pool_provider.github[0].name
}

output "deployer_service_account" {
  value = var.github_repository == "" ? "" : google_service_account.deployer[0].email
}

output "secret_ids_requiring_manual_versions" {
  description = <<-EOT
    Değeri Terraform tarafından **yazılmayan** sırlar. Bunlara bir sürüm eklenmeden
    servis ayağa kalkmaz — bu bilinçlidir: sağlayıcı sırları koda veya state'e girmez.
  EOT
  value = [
    for id in local.api_secret_ids :
    google_secret_manager_secret.managed[id].secret_id
    if !contains(local.terraform_managed_secret_ids, id)
  ]
}
