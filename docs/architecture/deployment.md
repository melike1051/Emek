# Dağıtım

Bağlayıcı kararlar: [ADR-0023](adr/0023-deployment-topology.md).
Yerel geliştirme: [local-development.md](local-development.md).

> **Bu belgedeki hiçbir adım bugüne kadar gerçek bir GCP projesinde çalıştırılmadı.**
> Terraform `fmt`/`validate` ile doğrulandı, container imajları gerçekten derlendi ve
> çalıştırıldı, smoke testleri gerçek bir container'a karşı koşturuldu. `terraform plan`,
> `apply` ve Cloud Run dağıtımı kimlik bilgisi olmadığı için **yapılmadı** (R-93).

## 1. Topoloji

```
                    ┌──────────────── GCP projesi (ortam başına bir tane) ───────────────┐
  mobil istemci ──► │ Cloud Run: emek-<env>-api   (ingress: all, invoker: allUsers)      │
                    │      │                                                              │
                    │      ├─ Direct VPC egress ─► Cloud SQL (özel IP, public IP yok)     │
                    │      │                    └─ Memorystore Redis (özel IP, AUTH+TLS)  │
                    │      ├─► Pub/Sub (4 domain topic + 4 DLQ)                           │
                    │      ├─► Cloud Storage: documents (private) / audit-archive (kilitli)│
                    │      ├─► Cloud KMS: identity-hash (MAC, rotasyonsuz)                │
                    │      ├─► BigQuery: emek_analytics.raw_events                        │
                    │      └─► Cloud Run: emek-<env>-ai (ingress: internal, IAM invoker)  │
                    │                                                                      │
                    │ Cloud Run Job: emek-<env>-migrate (yalnızca pipeline tetikler)       │
                    └──────────────────────────────────────────────────────────────────────┘
```

Staging ve production **ayrı projelerdir**. Aynı projede iki ortam IAM veya ağ
seviyesinde kaçınılmaz olarak birbirine bağlanır; ayrı proje "staging'den production
veritabanına bağlanmak" hatasını imkânsız kılar.

## 2. İlk kurulum (bootstrap)

Aşağıdaki adımlar ortam başına **bir kez** yapılır ve Terraform'dan öncedir —
Terraform kendi state'ini tutacağı bucket'ı oluşturamaz.

```bash
# 1. Proje ve state bucket'ı (ortam başına)
gcloud projects create emek-staging
gsutil mb -p emek-staging -l europe-west1 gs://emek-tfstate-staging
gsutil versioning set on gs://emek-tfstate-staging

# 2. Terraform'u başlat
cd infra/terraform/envs/staging
cp backend.hcl.example backend.hcl        # bucket adını yaz
terraform init -backend-config=backend.hcl
```

`terraform apply` için önce imaj gerekir; ilk apply'da geçici bir placeholder imaj
verilip ardından pipeline gerçek imajı dağıtabilir.

### Terraform'un yazmadığı sırlar

Terraform Secret Manager'da yalnızca **kabı** oluşturur. Şu sırların sürümleri
dışarıdan yazılır ve onlar yazılmadan servis ayağa kalkmaz:

| Sır                        | Kaynak                                           |
| -------------------------- | ------------------------------------------------ |
| `identity-callback-secret` | Kimlik doğrulama sağlayıcısı sözleşmesi          |
| `payment-webhook-secret`   | Lisanslı ödeme kuruluşu                          |
| `storage-signing-secret`   | Operatör üretir (mock imzalama yolu için)        |
| `ai-service-api-key`       | Operatör üretir (servisler arası paylaşılan sır) |

```bash
printf '%s' "$SECRET" | gcloud secrets versions add emek-staging-payment-webhook-secret --data-file=-
```

`database-url`, `redis-url` ve `redis-ca-cert` sırlarının değerini Terraform yazar: bunlar zaten
Terraform'un ürettiği kaynaklardan (parola, AUTH dizesi, özel IP) gelir ve
`terraform output` ile kontrol edilir. Düz env değişkeni yapılmazlar — kimlik
bilgisini Cloud Run servis tanımında `run.viewer` yetkisi olan herkesin
okuyabileceği bir yere koyardı.

### GitHub Actions değişkenleri

Terraform çıktılarından okunur ve **repository variables** olarak (secret değil —
bunlar gizli değer değildir) tanımlanır:

| Değişken                                              | Kaynak                                        |
| ----------------------------------------------------- | --------------------------------------------- |
| `STAGING_PROJECT_ID` / `PRODUCTION_PROJECT_ID`        | proje kimliği                                 |
| `STAGING_WORKLOAD_IDENTITY_PROVIDER` / `PRODUCTION_…` | `terraform output workload_identity_provider` |
| `STAGING_DEPLOYER_SERVICE_ACCOUNT` / `PRODUCTION_…`   | `terraform output deployer_service_account`   |

Bunlar tanımlı değilse `deploy.yml`'deki `preflight` işi dağıtımı **çalıştırmaz** ve
nedenini iş özetine yazar. Atlanan bir iş "dağıtıldı" demek değildir.

Production dağıtımının **iki** kapısı vardır ve ikisi de gereklidir:

1. **Repoda, okunabilir:** production işi yalnızca `workflow_dispatch` ile ve
   `deploy_production: true` girdisiyle çalışır. `main`'e push staging'e kadar gider
   ve orada durur.
2. **GitHub environment'ında, elle:** `production` environment'ına **required
   reviewers** tanımlanır. Bu repo dışında yapılandırılır, bu yüzden tek başına bir
   garanti sayılmaz — birinci kapı ona güvenmez.

## 3. Yayın akışı

```
CI (lint → typecheck → unit → integration → build → güvenlik taramaları)
  → imaj build + push (aynı digest, her iki projenin registry'sine)
  → staging migration (Cloud Run Job)
  → staging: aday revizyon, trafik YOK  → smoke (aday adrese) → trafiği taşı
  → [manuel tetikleme + environment onayı]
  → production: aynı digest → migration → aday revizyon → smoke → trafiği taşı
```

**Trafik smoke geçmeden taşınmaz.** Aday revizyon `--no-traffic --tag candidate` ile
dağıtılır ve kendi etiketli adresinde test edilir. Bu sıra olmadan smoke'un yakaladığı
her şey önce kullanıcıya çarpardı; ayrıca ayrı bir "geri al" adımına gerek kalmaz —
trafik hiç taşınmadıysa geri alınacak bir şey de yoktur.

**Production imajı yeniden build edilmez.** Aynı yerel imaj tek bir build işinde her
iki projenin registry'sine push edilir, yani iki yerde aynı digest. (`gcloud container
images add-tag` bu iş için kullanılamaz: projeler arası kopyalamaz.)

**Migration uygulama başlangıcında çalışmaz.** Ayrı bir Cloud Run Job'dur: aynı imaj,
farklı giriş noktası (`npm run migrate:deploy`), ayrı servis hesabı. Başlangıçta
migration çalıştırmak, ölçeklenen N instance'ın aynı anda şema değiştirmesi demektir.

**Sıra: geriye uyumlu migration → yeni revizyon.** Migration çalıştığında **eski**
revizyon hâlâ ayaktadır ve yeni şemaya karşı çalışmak zorundadır. Bir değişiklik eski
kodu bozacaksa iki dağıtıma bölünür:

1. **Genişlet:** yeni sütun/tablo eklenir, eski yol çalışmaya devam eder.
2. **Taşı:** yeni kod dağıtılır, veri taşınır.
3. **Daralt:** sonraki dağıtımda eski sütun kaldırılır.

## 4. Rollback

**Kod rollback'i trafiktir, yeniden dağıtım değil.** Cloud Run her dağıtımda değişmez
bir revizyon üretir:

```bash
# Revizyonları listele (en yeni önce)
gcloud run revisions list --service emek-production-api \
  --region europe-west1 --sort-by '~metadata.creationTimestamp'

# Trafiği bir öncekine ver
gcloud run services update-traffic emek-production-api \
  --region europe-west1 --to-revisions emek-production-api-00042-abc=100
```

Saniyeler sürer ve imaj yeniden çekilmez.

Pipeline'da ayrı bir geri alma adımı **yoktur ve gerekmez**: smoke düşerse trafik hiç
taşınmaz, çalışan revizyon etkilenmez ve aday revizyon inceleme için durur. Yukarıdaki
komut, sonradan fark edilen bir sorun için elle kullanılır.

**Şema geri alınmaz.** `node-pg-migrate down` üretimde çalıştırılmaz: denetim izini ve
veriyi götürebilir. Veri düzeyinde geri dönüş yolu Cloud SQL point-in-time recovery'dir
(7 günlük transaction log). Bu yüzden ileri yönlü migration'ların geriye uyumlu olması
bir tercih değil, gerekliliktir.

**Migration geri alınmaz — dağıtım başarısız olsa bile.** Migration adımı deploy'dan
öncedir; smoke düşse de çalışmış olabilir. Geriye uyumluluk bu yüzden bir gerekliliktir.

**Altyapı rollback'i:** Terraform'un `prevent_destroy` taşıyan kaynakları (KMS anahtarları,
Cloud SQL, keyring) geri alınamaz. Özellikle **audit arşivi bucket'ının kilitli retention
policy'si kalıcıdır** — süre kısaltılamaz, bucket süre dolmadan silinemez. Production'a
apply etmeden önce sürenin hukuk görüşüyle kesinleşmesi gerekir (A-04).

## 5. Doğrulama: smoke testleri

```bash
npx tsx services/api/scripts/smoke-test.ts \
  --api-url https://emek-staging-api-....run.app \
  --ai-url  https://emek-staging-ai-....run.app \
  --environment staging
```

Testler "200 döndü mü" ile yetinmez:

| Kontrol                      | Neyi yakalar                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------ |
| readiness + `checks` gövdesi | Postgres/PostGIS/Redis gerçekten ayakta mı                                     |
| sağlayıcı raporu             | Mock storage/`logging` transport ile ayağa kalkmış bir ortam (bu da 200 döner) |
| kimliksiz istek reddi        | Yetkilendirmenin kapalı kalması                                                |
| ops ucu koruması             | Dead-letter ve audit durumunun internete açılması                              |
| geçersiz token reddi         | App Check/auth guard'larının etkisizleşmesi                                    |
| 404 (5xx değil)              | Yanlış yönlendirme                                                             |
| hata gövdesi                 | Stack trace / bağlantı dizesi sızıntısı (T-31)                                 |
| AI erişilemezliği            | `ingress: internal` ayarının bozulması                                         |

Sağlayıcı raporu kontrolü, yerel bir container'a karşı koşturulduğunda **kasıtlı olarak
düşer** (`storage: gcs bekleniyordu, mock bulundu`) — testin gerçekten bir şey ölçtüğünün
kanıtı budur.

## 6. `TRUSTED_PROXY_HOP_COUNT` doğrulaması (R-53)

Terraform bu değeri Cloud Run için **`1`** olarak ayarlar; "istemci, google-lb" zinciri
`2`yi akla getirir ama bu ölçülmemiştir.
Bu **varsayımdır** ve gerçek topolojide doğrulanması gerekir. Dağıtımdan sonra:

1. Bilinen bir adresten istek at, `X-Forwarded-For: 1.2.3.4` başlığı ekle.
2. Uygulama logunda `requestId` ile ilişkili oran sınırı kovasının gerçek istemci
   adresini mi yoksa `1.2.3.4`'ü mü kullandığını kontrol et.
3. `1.2.3.4` görünüyorsa hop sayısı **fazladır** ve sınır atlatılabilir; tek bir global
   kova görünüyorsa **azdır**.

Bu adım gerçek bir dağıtım gerektirir ve Faz 13'te yapılamamıştır. Terraform değeri
**1** olarak ayarlar, 2 değil: fazla bir hop sayısı fail-**open**'dır (saldırgan XFF
zincirini kendisi uzatıp oran sınırını atlatır), eksik bir hop sayısı ise fail-closed
(sınır daralır). Ölçülene kadar güvenli taraf budur (A-10, R-53).

## 7. Bilinen tuzaklar

- **`NODE_ENV=development` ile production imajı başlamaz.** Geliştirme logger'ı
  `pino-pretty` ister; o bir devDependency'dir ve çalışan imajda yoktur. Staging
  `NODE_ENV=staging` kullanır ve JSON log yazar. Hata boot'ta ve açıktır.
- **`PUBSUB_EMULATOR_HOST` production'da reddedilir.** Ayarlı kalırsa publish
  çağrıları emulator'e gider.
- **Terraform apply, pipeline'ın dağıttığı imajı geri almaz.** `template[0].containers[0].image`
  `ignore_changes` içindedir: `var.api_image` yalnızca ilk kurulumdaki başlangıç
  değeridir. Bu olmadan her `apply`, çalışan revizyonu bootstrap imajına döndüren
  sessiz bir uygulama rollback'i olurdu.
- **`NODE_ENV=staging` artık production ile aynı sertleştirme kurallarına tabidir.**
  Mock sağlayıcılarla staging ayağa kalkmaz. Yerelde production imajını denemek için
  `NODE_ENV=test` kullanılır.
- **Artifact Registry `immutable_tags` açıktır.** Aynı etiketi yeniden push etmek
  başarısız olur; bu bilinçlidir (etiket taşınırsa hangi kodun çalıştığı belirsizleşir).
