output "api_url" {
  value = module.emek.api_url
}

output "ai_url" {
  value = module.emek.ai_url
}

output "api_service_name" {
  value = module.emek.api_service_name
}

output "ai_service_name" {
  value = module.emek.ai_service_name
}

output "migrate_job_name" {
  value = module.emek.migrate_job_name
}

output "artifact_registry" {
  value = module.emek.artifact_registry
}

output "workload_identity_provider" {
  value = module.emek.workload_identity_provider
}

output "deployer_service_account" {
  value = module.emek.deployer_service_account
}

output "secret_ids_requiring_manual_versions" {
  value = module.emek.secret_ids_requiring_manual_versions
}
