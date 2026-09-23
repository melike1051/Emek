# ADR-0023 — Dağıtım topolojisi, kimlik ve yayın süreci

Durum: kabul edildi (Faz 13)
İlgili: ADR-0001 (modular monolith), ADR-0003 (PostgreSQL), ADR-0004 (kimlik hash'i),
ADR-0010 (Pub/Sub), ADR-0013 (yetkilendirme ve audit), ADR-0021 (analytics), ADR-0022 (güvenlik)

## Bağlam

Faz 12'ye kadar Emek yalnızca yerelde ve CI'da çalıştı. Production'a çıkabilmek için
dört boşluk vardı ve hepsi risk kütüğünde açıktı:

- **R-39:** `IDENTITY_HASH_KEY_SOURCE=kms` production'da zorunluydu ama KMS adapter'ı yoktu.
- **R-41:** GCS adapter'ı yoktu; bucket politikası yalnızca belgeydi.
- **R-82:** Audit arşivi yalnızca bellekteydi; "bağımsız kopya" iddiası taşınamıyordu.
- **R-83:** Storage ve BigQuery için yaşam döngüsü politikası yoktu.

Bunlar "eksik kod" değildi; **iddia ile gerçeğin ayrıştığı** noktalardı. Faz 13'ün
işi bu ayrışmayı kapatmak ve kapanmayan yeri açıkça işaretlemekti.

## Karar

### 1. İki ayrı GCP projesi, ortak modül

`staging` ve `production` **ayrı projelerdir** ve ayrı Terraform state'i tutar.
Ortak yapı tek bir modülde (`infra/terraform/modules/emek_environment`) tanımlanır;
ortam kökleri yalnızca boyut ve koruma parametrelerini değiştirir.

Gerekçe: aynı projede iki ortam, IAM veya ağ seviyesinde kaçınılmaz olarak birbirine
bağlanır. Ayrı proje, "staging'den production veritabanına bağlanmak" hatasını
yapılandırma hatası olmaktan çıkarıp imkânsız hale getirir.

Staging **gerçek sağlayıcıları** çalıştırır (KMS, GCS, Pub/Sub, BigQuery). Sahte
sağlayıcılarla çalışan bir staging, production'a çıkmadan önce hiçbir şeyi kanıtlamaz.

Bu bir tercih değil, **config katmanında zorlanan** bir kuraldır: `env.schema`'nın
sertleştirme kontrolleri `NODE_ENV=staging` için de çalışır. Aksi halde elle
değiştirilen tek bir ortam değişkeni staging'i sessizce mock'a düşürürdü ve tek
savunma dağıtım **sonrası** smoke testi olurdu — yani geç kalmak.

### 2. Kimlik hash'i KMS'te imzalanır, anahtar uygulamaya inmez

Önceki port anahtar **materyalini** döndürüyordu (`key(): Promise<Buffer>`). Bu,
Cloud KMS'in MAC anahtarlarıyla zaten mümkün değildir ve olsa bile istenmezdi:
anahtarı süreç belleğine getirmek KMS'i bir "secret store"a indirger, heap dump
veya log onu sızdırır.

Port artık **HMAC'in kendisidir**: `mac(message: Buffer): Promise<Buffer>`.
Uygulama normalize edilmiş mesajı verir, etiketi alır. Yerelde HMAC süreç içinde,
production'da Cloud KMS `macSign` ile hesaplanır.

Anahtar **rotasyona tabi değildir** (ADR-0004 §5) ve yapılandırma tam **sürüm**
kaynak adını ister. "Primary" sürüme bırakmak, KMS tarafındaki bir değişikliğin
aynı kişi için farklı hash üretmesine — yani mükerrer hesap kontrolünün sessizce
bozulmasına — izin verirdi.

### 3. Yapılandırma doğru diye kabul edilmez, boot'ta doğrulanır

Üç adapter başlatmada kendi altyapısını denetler ve yanlışsa **servisi başlatmaz**:

| Adapter                   | Doğrulama                                              | Yanlışsa ne olurdu                                                     |
| ------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `GcsStorageProvider`      | uniform bucket-level access + public access prevention | Kanıt fotoğrafları imza olmadan okunabilirdi (R-41)                    |
| `GcsAuditArchive`         | **kilitli** retention policy + public erişim engeli    | Arşiv silinebilir olurdu; "değişmez kopya" iddiası sahte olurdu (R-82) |
| `KmsIdentityMacProvider`  | 32 baytlık etiket üreten kanarya imzası                | Yanlış algoritmalı anahtar tekilliği bozardı (R-39)                    |
| `PubSubSubscriberService` | beklenen subscription'ların varlığı                    | Servis "event tüketiyor" görünürken hiçbir şey tüketmezdi              |

Boot başarısız olursa Cloud Run yeni revizyona trafik vermez ve **önceki revizyon
hizmet vermeye devam eder**. Yani yanlış yapılandırma bir kesinti değil, başarısız
bir dağıtımdır.

Ayrım bilinçlidir: Pub/Sub kontrolünün **kendisi** hata verirse (geçici API arızası)
yalnızca uyarı yazılır. Geçici bir arızada crash-loop'a girmek, çalışan revizyonu
da götürürdü.

Arşivin değişmezliği **altyapıdadır, uygulamada değil**: bucket'ın kilitli retention
policy'si her nesneye otomatik uygulanır ve servis hesabının rolü `objectCreator`'dır —
silme, güncelleme ve saklama süresi değiştirme izni yoktur. Bu yüzden uygulama nesne
bazlı saklama süresi yazmaz; bunun yerine istenen süreyi bucket'ın **gerçekten garanti
ettiği** süreyle karşılaştırır ve garanti yetmiyorsa yazmayı reddeder. Altyapının
veremediği bir garantiyi vermiş gibi davranmak, arşivi kâğıt üzerinde bırakırdı.

### 4. Keyless CI/CD

Uzun ömürlü servis hesabı JSON anahtarı **oluşturulmaz**. Böyle bir anahtar
repository secret'ında durur, süresi dolmaz, sızdığında iz bırakmaz ve iptali
manueldir. Yerine GitHub Actions'ın OIDC token'ı Workload Identity Federation ile
federe edilir; sağlayıcıda `assertion.repository` koşulu vardır ve production
için yalnızca `refs/heads/main` kabul edilir.

Deploy kimliğinin doğrudan yetkileri dardır: imaj yazar, revizyon dağıtır, migration
job'u çalıştırır; Secret Manager, Cloud SQL ve IAM politikaları üzerinde rolü yoktur.

Ama bu **"sırlara erişemez" anlamına gelmez** ve öyle iddia edilmemelidir: `run.developer`

- uygulama servis hesabı üzerinde `serviceAccountUser`, keyfi bir imajı o kimlikle
  çalıştırabilmek demektir — o kimlik de sırları okur. Bu, dağıtım yetkisinin doğasındadır
  ve rol daraltmasıyla kapatılamaz. Asıl kapı bu yüzden **WIF koşulunun darlığıdır**:

* Sağlayıcı koşulu `repository` **ve** `repository_owner` **ve** `ref == refs/heads/main`
  ister; bu **staging için de** geçerlidir (staging gerçek sırlar ve gerçek bir veritabanı
  taşır, "yalnızca test ortamı" değildir).
* Servis hesabı bağlaması ayrıca `attribute.ref/refs/heads/main` principal kümesiyle
  sınırlıdır; sağlayıcı koşulu ileride gevşetilirse bu bağlama hâlâ dar kalır.

Yalnızca `repository` koşulu yeterli olmazdı: repoya push yetkisi olan herkes bir
feature dalına `id-token: write` isteyen bir workflow ekleyip dağıtım kimliğini alırdı.
WIF, token'ı hangi workflow'un istediğini umursamaz. (R-90)

### 5. Migration uygulama başlangıcında çalışmaz

Migration ayrı bir Cloud Run **Job**'udur: aynı imaj, farklı giriş noktası, ayrı
servis hesabı, yalnızca pipeline'dan tetiklenir.

Gerekçe: başlangıçta migration çalıştırmak, ölçeklenen N instance'ın aynı anda şema
değiştirmesi demektir. Ayrıca rollback'i imkânsızlaştırır — eski imaja dönmek eski
şemayı geri getirmez.

Sıra: **geriye uyumlu migration → yeni revizyon**. Bir migration eski revizyonu
bozacaksa iki dağıtıma bölünür (genişlet → taşı → daralt).

### 6. Trafik smoke geçmeden taşınmaz; rollback revizyon trafiğidir

Yeni revizyon `--no-traffic --tag candidate` ile dağıtılır ve **hiç trafik almaz**.
Smoke testi aday revizyonun kendi etiketli adresinde koşar; ancak geçerse trafik
`--to-latest` ile taşınır.

Bu sıra önemlidir: "yanlış yapılandırma bir kesinti değil, başarısız bir dağıtımdır"
iddiası, trafik önce taşınsaydı yalnızca **boot** hataları için doğru olurdu. Smoke'un
yakaladığı her şey (yanlış sağlayıcı, açık kalmış guard, sızan hata gövdesi) önce
kullanıcıya çarpardı. Ayrıca ayrı bir "geri al" adımına gerek kalmaz: trafik hiç
taşınmadıysa geri alınacak bir şey de yoktur.

Çalışan bir revizyondan geri dönüş yine trafiktir (`gcloud run services update-traffic`)
ve saniyeler sürer.

Şema geri alınmaz: `node-pg-migrate down` üretimde **çalıştırılmaz** (denetim izini
ve veriyi götürebilir). Veri düzeyinde geri dönüş yolu Cloud SQL point-in-time
recovery'dir.

### 7. İmajlar digest ile dağıtılır

Etiket sonradan başka bir içeriğe taşınabilir; digest taşınamaz. Artifact Registry
`immutable_tags` ile bunu ayrıca zorlar.

Production'a **staging'de doğrulanan aynı imaj** gider. Bu, tek bir build işinde aynı
yerel imajın her iki projenin registry'sine push edilmesiyle sağlanır — yani iki
registry'de aynı digest. `gcloud container images add-tag` bu iş için kullanılamaz:
yalnızca aynı repository içinde etiket ekler, projeler arası kopyalamaz.

## Sonuçlar

**Kapanan:** R-39, R-41, R-82, R-83 (aşağıdaki sınırla birlikte).

**Kabul edilen sınır:** bu fazda gerçek bir GCP projesi, faturalandırma hesabı veya
kimlik bilgisi yoktur. Terraform `fmt` ve `validate` ile doğrulanmıştır; `plan` ve
`apply` **çalıştırılmamıştır**. "Staging Terraform'dan sıfırdan kurulabiliyor"
ifadesi bu yüzden Faz 13'te **kanıtlanmamıştır** ve exit kriteri olarak açık
bırakılmıştır (R-93).

**Değişen sözleşme:** `IdentityHashKeyProvider` → `IdentityMacProvider`. Port
tüketicisi yalnızca `IdentityHasher`'dır; dış API veya veritabanı şeması etkilenmez.

**Sır sürümleri `latest`'tir.** Sürüm pinlenseydi her sır rotasyonu yeni bir dağıtım
gerektirirdi; `latest` ile rotasyon instance yenilenmesinde devreye girer. Bu, KMS
anahtar sürümünün açıkça pinlenmesiyle (§2) tutarsız **görünür** ama farklı bir şeydir:
anahtar değişimi mevcut hash'leri geçersiz kılar ve geri dönüşü yoktur; bir webhook
sırrının değişimi yalnızca geçiş penceresi ister. Bedeli: sağlayıcı sırrı çift kabul
penceresi olmadan döndürülürse imza doğrulaması kısa süre kırılır (R-91).

**Eşikler varsayımdır:** alarm eşikleri (5xx > 10/5dk, p95 > 2sn, backlog > 10dk)
tanımlı bir SLO'dan gelmiyor. A-09 olarak kaydedildi; gerçek değerler Faz 14'te
ölçülecek.
