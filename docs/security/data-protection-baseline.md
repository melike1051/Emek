# Data Protection & Security Baseline

Bu doküman **teknik** tasarımdır. Veri işleme envanteri, hukuki dayanak, aydınlatma/açık rıza
metinleri, saklama-imha politikası ve sağlayıcı sözleşmeleri **hukuk uzmanı tarafından
doğrulanmalıdır**. Doğrulama gerektiren noktalar `TODO(legal)` ile işaretlidir.

## 1. Veri sınıflandırması

| Sınıf                                       | Örnek                                                                            | Kural                                                                                                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S3 — Özel nitelikli / yüksek hassasiyet** | biyometrik veri, adli sicil bilgisi, sağlık bilgisi                              | Varsayılan: **toplanmaz**. Zorunlu hale gelirse ayrı ADR + `TODO(legal)` + ayrı erişim kontrolü + kısa retention + her erişimin loglanması.                                                            |
| **S2 — Kimlik ve finansal referans**        | T.C. kimlik numarası, kimlik belgesi görüntüsü, ödeme referansı                  | Ham TCKN ve belge görüntüsü **core sistemde saklanmaz**. Yalnızca `provider_subject_id` veya KMS anahtarlı HMAC `identity_hash` + doğrulama sonucu tutulur. Kart verisi hiçbir koşulda sisteme girmez. |
| **S1 — Kişisel veri**                       | ad, telefon, e-posta, adres, konum olayları, before/after fotoğraf, review metni | En az yetki, şifreli aktarım, retention, erişim logu. Loglara yazılmaz/maskelenir.                                                                                                                     |
| **S0 — Operasyonel/türetilmiş**             | booking durumu, skor bileşenleri, metrikler, event sayaçları                     | Serbestçe işlenebilir; analitikte kimlik bilgisi minimize edilir.                                                                                                                                      |

## 2. Kimlik verisi ilkeleri

- Ham T.C. kimlik numarası tablolara yayılmaz. Saklanan: sağlayıcı `provider_subject_id` **ve**
  Cloud KMS anahtarıyla üretilen **HMAC-SHA256** `identity_hash`. Tekillik kontrolünün birincil
  dayanağı `identity_hash`'tir (sağlayıcıya göre kapsamlı subject id tek başına yeterli değildir —
  ADR-0004 §2).
- Düz `SHA256(TCKN)` **yasak** — 11 haneli uzay brute-force edilebilir.
- HMAC anahtarı KMS'te **non-exportable** olarak tutulur; kodda, env dosyasında veya DB'de bulunmaz.
  **Otomatik rotasyon kapalıdır:** ham girdi saklanmadığı için mevcut hash'ler yeniden hesaplanamaz
  ve anahtar değişimi tekillik kontrolünü sessizce bozar. `hash_key_version` teşhis amaçlıdır.
  Anahtar zorunlu olarak değişirse tek geçerli yol kullanıcıların yeniden doğrulanmasıdır (Faz 12 prosedürü).
- `identity_hash`, ham kimlik verisini gören tek bileşen olan **adapter içinde** üretilir.
  Adapter sınırından geçen ham kimlik alanları normalize edilip **atılır**; core domain görmez.
- "Kimlik doğrulandı" rozeti ile "adli sicil temiz" iddiası farklı alanlardır; karıştırılmaz.
- NFC tek başına "telefonu tutan = kart sahibi" kanıtı değildir; `assuranceLevel` saklanır ve
  yüksek güven gerektiren akışlarda minimum seviye talep edilir.

## 3. Konum ve safety verisi

- Telemetri yalnızca aktif hizmet oturumunda toplanır. 24 saat takip yok.
- `location_events` yüksek hacimlidir: zamana göre partition + retention.
  Varsayılan öneri **30 gün** ham kayıt, sonrasında trajektori özeti/agregat. `TODO(legal)`: süre doğrulanacak.
- Dispute/emergency vakalarında ilgili oturum verisi hukuki saklama süresince ayrı tutulur ve
  her erişimi loglanır.
- Kullanıcı, oturum dışında konumunun izlenmediğini uygulamada görebilmelidir (şeffaflık).
- Telemetri istemciden gelir ve **güvenilmez girdidir**: sunucu zamanı yetkilidir
  (`server_received_at`), oturum başına monoton sıra numarası replay'i engeller, mock-location
  sinyali kayda geçer. "Dijital ispat" tamper-**evident**'tır, tamper-proof değildir (ADR-0008 §7-8).

**Faz 8 uygulaması** ([safety.md](../architecture/safety.md), [tehdit modeli](safety-threat-model.md)):

| Veri                                  | Sınıf | Nerede                                     | Saklama / minimizasyon                                                       |
| ------------------------------------- | ----- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| Ham konum örneği                      | S1    | `location_events` (aylık partition)        | planlanan bitiş + 30 gün (`TODO(legal)`), sonra **silinir**                  |
| Panik oturumunun ham konumu           | S1    | aynı                                       | en az panik + 365 gün kanıt süresi (`TODO(legal)`, R-58)                     |
| Oturumun son konumu                   | S1    | `safety_sessions.last_*`                   | ham konumla birlikte NULL'lanır                                              |
| Hizmet noktası (oturum kopyası)       | S1    | `safety_sessions.service_location`         | retention'da ~1 km'ye yuvarlanır                                             |
| Güvenlik olayı / risk değerlendirmesi | S2    | `safety_events`, `safety_risk_assessments` | append-only kanıt; **koordinat içermez** (mesafe, süre, sayaç, kural kanıtı) |
| Müşteri konumu                        | —     | **toplanmaz**                              | —                                                                            |

- Koordinat anahtarları (`latitude`, `longitude`, `lat`, `lon`, `lng`) log redaksiyon listesindedir.
- Ham iz yalnızca `ADMIN`'e açıktır ve her okuma `SAFETY_LOCATION_ACCESSED` olarak audit'lenir.
- AI servisine ham iz gitmez; yalnızca türetilmiş sinyaller ve varış aşamasında iki nokta.
- Silme hakkı: olay/değerlendirme tablolarında kullanıcıya FK yoktur (`actor_user_id` FK'siz);
  tabloların kanıt saklama süresi ve silme politikası R-38 ile birlikte Faz 12'de. `TODO(legal)`

## 3b. Dijital ispat dokümanları (Faz 5)

Before/after fotoğrafı S1'dir ve müşterinin evinin içini gösterir; bu yüzden en dar erişim
modeliyle tasarlanmıştır:

- Dosya **Cloud Storage**'dadır; PostgreSQL yalnızca metadata + `sha256` + `storage_key`
  tutar. Binary veritabanına girmez.
- Nesneler **private**'tır. Storage portunda public URL üretme yeteneği **bilinçli olarak
  yoktur**: olsaydı bir yerde yanlışlıkla çağrılabilirdi. Erişim yalnızca kısa ömürlü
  (varsayılan 300 sn) imzalı URL iledir (T-12).
- `storage_key` rastgeledir: tahmin edilebilir bir yol, imza doğrulaması dışında ikinci bir
  savunma katmanını kaybettirirdi.
- Erişim rezervasyonun **taraflarına** (ve operatöre) açıktır; her indirme URL'i üretimi
  `DOCUMENT_ACCESS_GRANTED` olarak audit'lenir.
- `sha256` **storage'daki nesneden okunur**, istemcinin beyanından değil; yazıldıktan sonra
  trigger ile değiştirilemez. "Dijital ispat" tamper-**evident**'tır.
- İçerik tipi beyaz listeyle sınırlıdır ve azami boyut yapılandırmadan gelir.
- `TODO(legal)`: kanıt fotoğraflarının saklama süresi ve uyuşmazlık sonrası imha politikası
  Faz 12 retention listesine girecek.

## 3c. Ödeme verisi (Faz 5)

- Kart verisi (PAN, CVV, son kullanma) **hiçbir kolonda yoktur**; ödeme sayfası/SDK
  sağlayıcıya aittir ve Emek PCI kapsamı dışındadır. Bu şema seviyesinde test edilir.
- `payment_events` ham sağlayıcı gövdesini değil **sınıflandırılmış özeti** saklar.
- Sağlayıcı referansı (`external_payment_id`) istemciye dönen yanıtlarda yer almaz.

## 4. Erişim kontrolü

- Authentication: Firebase Auth; backend her istekte token doğrular. Client integrity: App Check.
- Authorization: RBAC (`CUSTOMER`, `PROVIDER`, `ADMIN`, `SUPPORT`) + **ownership kontrolü**,
  **deny by default** (ADR-0013). Rol tek başına yetmez: kullanıcı yalnızca kendi kaynağına erişir
  (IDOR testi zorunlu — T-30); guard'sız endpoint testi kırar (T-37). Yetki kontrolü veri erişim
  katmanında da uygulanır, yalnızca controller'da değil. Rol yetenek matrisi: `docs/security/rbac-matrix.md` (Faz 2).
- `SUPPORT` rolü yıkıcı aksiyon (silme, ödeme serbest bırakma, rol değiştirme) yapamaz.
- Veritabanı rolleri en az yetkili: AI servisi **read-only** rol; `audit_logs` için UPDATE/DELETE
  yetkisi hiçbir uygulama rolüne verilmez (append-only).
- Object storage private; erişim yalnızca kısa ömürlü signed URL ile.

## 5. Secret ve anahtar yönetimi

- Tüm secret'lar Secret Manager'da; repoda ve image içinde secret yok. `.env.example` gerçek değer içermez.
- Kriptografik anahtarlar Cloud KMS'te; HMAC identity anahtarı, webhook imza anahtarları dahil.
- CI'da secret scanning bloklayıcı. Sızan secret derhal rotasyona alınır.
- Ortam ayrımı: development / staging / production ayrı proje/secret seti; staging production
  verisi içermez.

## 6. Denetim (audit)

`audit_logs`'a yazılan asgari olaylar: rol değişimi, verification onay/ret, identity kaydı oluşumu,
account recovery, ödeme durumu değişimi, refund, dispute çözümü, admin müdahalesi,
safety alert aksiyonu, S1/S2 veriye erişim.

Kayıt: `actor_user_id`, `action`, `entity_type`, `entity_id`, `old_value`, `new_value`, `ip_address`,
`created_at`, `prev_hash`, `hash`.

Bütünlük mekanizması (ADR-0013, **Faz 2'de kurulur**):

- Uygulama DB rolünün `audit_logs` üzerinde yalnızca INSERT + SELECT yetkisi vardır; UPDATE/DELETE yok.
- Satırlar hash zinciriyle bağlanır; zincir periyodik doğrulanır, kopukluk alarm üretir.
  Bu, ayrıcalıklı bir rolün geçmişi yeniden yazmasını engellemez ama **tespit edilebilir** kılar.
- Kayıtlar retention-locked bir hedefe periyodik olarak aktarılır; DB tek kopya değildir.
- Audit kaydı kritik işlemle **aynı transaction'da** yazılır; event ile sonradan yazılmaz.
- `old_value`/`new_value` hassas veri taşımaz (token, ham kimlik, kart verisi yok).

## 7. Uygulama güvenliği

- Transport HTTPS/TLS; HTTP dinlenmez.
- Girdi doğrulama tüm sistem sınırlarında (request, webhook, event, AI yanıtı).
- SQL yalnızca parametreli; string birleştirme yasak.
- Rate limiting: OTP isteği, verification denemesi, login, panic dışı yazma endpoint'leri.
  Redis erişilemezse güvenlik kritik yollarda **fail-closed**.
- Webhook endpoint'leri: imza doğrulama + replay koruması + idempotency.
- Kullanıcıya dönen hatalar kodlu; ham exception/stack/SQL sızdırılmaz.
- Dependency scanning + SAST CI'da; kritik/high bulgu bloklayıcı.
- `raw_text` ve tüm kullanıcı içeriği LLM katmanında **veri**dir, talimat değildir (T-14).

## 8. Veri sahibi hakları ve yaşam döngüsü

- Silme/anonimleştirme talebi: finansal ve hukuki saklama yükümlülüğü olan kayıtlar
  (ödeme, dispute, audit) korunur; diğer kişisel alanlar anonimleştirilir. Kesin kapsam `TODO(legal)`.
- Veri taşınabilirliği ve erişim talebi için export yolu Faz 12'de tanımlanır.
- Retention tabloları ve süreleri Faz 12'de tek listede toplanır ve **çalışan bir job ile
  gerçekten uygulanır** (T-24).

## 9. Hukuki doğrulama bekleyen noktalar

Ayrıntı ve takip: `docs/research/technical-risks.md`.

- `TODO(legal)`: EKDS/KDHS veya yetkili identity sağlayıcı erişim modeli ve izinleri.
- `TODO(legal)`: ödeme kuruluşunun şartlı ödeme/marketplace payout yetkinliği ve sözleşme şartları.
- `TODO(legal)`: konum verisi retention süresi.
- `TODO(legal)`: biyometrik/liveness doğrulama kullanılacaksa hukuki dayanak ve aydınlatma.
- `TODO(legal)`: adli sicil bilgisi talep edilecekse dayanak, kapsam ve saklama.
- `TODO(legal)`: KVKK veri işleme envanteri, aydınlatma metinleri, açık rıza akışları.
- `TODO(legal)`: kanıt fotoğrafı/dokümanı saklama süresi ve uyuşmazlık sonrası imha.
- `TODO(legal)`: uyuşmazlık kararlarının ve ödeme kayıtlarının zorunlu saklama süresi
  (ticari/vergisel mevzuat) ile KVKK silme talebinin kesişimi.
