# Terraform — Emek altyapısı

Kararlar: [ADR-0023](../../docs/architecture/adr/0023-deployment-topology.md).
Kurulum ve yayın akışı: [deployment.md](../../docs/architecture/deployment.md).

```
modules/emek_environment/   Tek ortamın tüm kaynakları (ortak tanım)
envs/staging/               Staging kökü  — ayrı proje, ayrı state
envs/production/            Production kökü — ayrı proje, ayrı state
```

## Doğrulama

```bash
terraform fmt -recursive -check -diff          # infra/terraform içinden
cd envs/staging && terraform init -backend=false && terraform validate
```

CI bunu her iki ortam için çalıştırır (`.github/workflows/terraform.yml`).
`plan` kimlik bilgisi gerektirir ve CI'da çalıştırılmaz.

## State

State **repository'de değildir** ve olamaz: veritabanı parolası ve Redis AUTH
dizesi gibi Terraform'un ürettiği sırlar state'te bulunur. Backend kısmi
yapılandırmadır; bucket adı `backend.hcl` ile verilir (`.gitignore`'da).

State bucket'ı ayrı bir yönetim projesinde, versiyonlu ve erişimi kısıtlı olmalıdır.

## Geri alınamaz kaynaklar

Aşağıdakiler bilinçli olarak korunur veya kalıcıdır; `terraform destroy` ile
kaldırılamaz ya da kaldırılması veri kaybıdır:

| Kaynak                                                       | Neden                                                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `google_kms_key_ring`, `google_kms_crypto_key.identity_hash` | Anahtar kaybı **tüm** kimlik hash'lerini geçersiz kılar; ham veri saklanmadığı için yeniden hesaplanamaz (ADR-0004 §5) |
| `google_sql_database_instance`                               | Tek transactional doğruluk kaynağı                                                                                     |
| `audit_archive` bucket'ının kilitli retention policy'si      | **Kilit geri alınamaz**: süre kısaltılamaz, bucket süre dolmadan silinemez (R-82)                                      |

Kilitli retention süresi (`audit_archive_retention_days`) production'a apply
edilmeden önce hukuk görüşüyle kesinleşmelidir (A-04).

## Bu fazda yapılmayan

Gerçek bir GCP projesi, faturalandırma hesabı ve kimlik bilgisi olmadığı için
`terraform plan` ve `apply` **çalıştırılmamıştır**. Yapılandırma sözdizimi, şema
ve sağlayıcı uyumluluğu açısından doğrulanmıştır; kaynakların gerçekten
oluşturulabildiği doğrulanmamıştır (R-93).
