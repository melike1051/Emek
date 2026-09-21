# ADR-0019 — Faz 8 Safety Domaini: Oturum Booking'i İzler, Kurallar Karar Verir, Model Destekler, Panik Yalnızca DB'ye Bağlıdır

- Durum: Accepted (2026-09-22)
- Faz: 8
- Blueprint: §14, §24
- İlgili: [ADR-0008](0008-session-scoped-safety.md), [ADR-0002](0002-language-boundaries.md),
  [ADR-0012](0012-research-versioning.md), [ADR-0013](0013-authorization-and-audit-integrity.md),
  [ADR-0018](0018-matching-decision-chain.md)

## Bağlam

ADR-0008 ilkeleri koydu (oturum bazlı telemetri, rules + ML hibriti, ML'den bağımsız
panik, retention, telemetri güvenilmez girdidir) ama uygulamanın zor sorularını açık
bıraktı: oturum hangi booking durumunda açılır ve kim ilerletir; geofence belirsizliği
nasıl temsil edilir; kural ile model aynı girdiyi nasıl görür; panik hangi
bağımlılıklara dokunur; değerlendirme AI'ı beklerken veritabanı bağlantısı tutar mı.
Bu ADR o soruları yanıtlar. Ayrıntılı tasarım: [safety.md](../safety.md).

## Karar

### 1. İkinci bir iş yaşam döngüsü yoktur

Oturum durumları (`NOT_STARTED → PRE_SERVICE → ARRIVAL_MONITORING → ACTIVE → CLOSED`)
booking durumundan **türer**. Tek eşleme `safetyEffectForBooking()`'tedir ve tek
çağrı noktası `BookingStateService.transition()`'dır — booking geçişiyle **aynı
transaction'da**. Ödeme, matching, operatör ve taraflar durumu hep bu yoldan
ilerlettiği için oturum hiçbir yolda unutulamaz. Bu çağrı yalnızca veritabanına yazar;
booking geçişi AI, rota ya da bildirim servisine bağımlı hâle gelmez.

- `SCHEDULED` oturum **açar ama telemetri kabul etmez** (rezervasyon var diye konum
  toplanmaz).
- `PROVIDER_ARRIVING` telemetriyi açar; `CHECKED_IN` aktif hizmet; `CHECKED_OUT` /
  `CANCELLED` / `COMPLETED` kapatır.
- `SAFETY_HOLD` oturuma dokunmaz: askıda izleme sürer.
- Veritabanı iki invariant'ı ayrıca garanti eder (trigger): durum geri gitmez, `CLOSED`
  terminaldir. Tablonun kopyası tutulmaz (R-48 dersi).
- Rezervasyon başına **tek** oturum (tam unique index); kapanan oturum yeniden açılmaz.
- Etkin panik varken oturumu kapatan booking geçişi reddedilir (önce acil durum çözülür).
- **Kilit sırası:** booking (`FOR NO KEY UPDATE`) → oturum → global audit kilidi (en son).
  `FOR UPDATE`, oturum kilidini tutup `safety_events` yazan işlemin booking FK'si için
  aldığı `KEY SHARE`'i bloklayıp check-out ile deadlock üretiyordu (Faz 8 review; testle
  yeniden üretildi). Bu nedenle Faz 4/5'teki booking kilitleri de `FOR NO KEY UPDATE`'e
  çevrildi — geçişleri yine sıraya sokar, uyumluluk düzeltmesidir.
- Modül bağımlılığı tek yönlüdür: `BookingStateModule` → `SafetyCoreModule` (yalnızca
  yaşam döngüsü + repository). Safety'nin HTTP/izleyici katmanı booking'e bağlıdır, tersi
  değil.

### 2. Yalnızca sağlayıcı konum gönderir

Müşterinin konumu toplanmaz: hizmet noktası zaten müşterinin adresidir ve korunan
taraf sağlayıcıdır. Panik ise **iki taraf** için de açıktır.

### 3. Telemetri: tek kısa transaction, saf doğrulayıcı, PostGIS mesafe

İstek başına oturum kilitlenir, paket (≤ 20 örnek) **saf** bir fonksiyondan geçer
(`processBatch`: sıra/zaman/hız doğrulama + geofence + debounce), mesafeler tek PostGIS
sorgusuyla hesaplanır, kabul edilenler tek INSERT ile yazılır. Ingest yolunda **dış
çağrı yoktur**. Aynı saf fonksiyon EXP-004'te de çalışır: ölçülen ile çalışan aynıdır.

İstemci sahiplik, oturum durumu, geofence sonucu ve risk seviyesi **gönderemez**
(DTO'da alanı yoktur). Sunucu zamanı yetkilidir; oturum başına monoton sıra numarası
replay'i engeller; ret de sıra numarasını tüketir. Telemetri ve panik uçlarında global
(IP bazlı, kimlik doğrulama öncesi, Redis'li) oran sınırı **yoktur**: Cloud Run arkasında
tek IP kovası, kimliksiz bir saldırganın tüm sağlayıcıların telemetrisini kesmesine
izin verirdi (review bulgusu). Bunun yerine kimlik doğrulandıktan sonra, kullanıcı
başına, süreç içi bir sınır uygulanır; kalıcı koruma oturumdaki sıra/aralık kontrolüdür.

### 4. Geofence dört değerlidir ve debounce edilir

`INSIDE`, `OUTSIDE`, `BOUNDARY`, `INSUFFICIENT_ACCURACY` (+ başlangıç `UNKNOWN`).
Doğruluk dairesi ve yarıçapın %10'u (≥ 10 m) histerezis bandı kesin yargıyı
zorlaştırır. Kesin durum 3 ardışık gözlemle kabul edilir; belirsiz gözlemler adayı
sıfırlar ama durumu değiştirmez. Olay yalnızca kalıcı geçişte yazılır. Yarıçap tek
evrensel değer değildir, oturuma kopyalanır (R-56).

### 5. Kurallar deterministiktir, sürümlüdür ve modelden bağımsızdır

10 kural, her biri kimlik + sürüm + **sinyal ailesi** taşır (`safety-rules-v2`). Hiçbir
kural anomali skorunu okumaz; hiçbir kural `EMERGENCY` üretmez. Kural ve model **aynı**
normalize sinyal yapısını tüketir (`SafetySignals`, beklenen/gözlenen ayrımı açık,
`null` = "bilinmiyor", eksik sinyaller listelenir).

### 6. Risk toplama politikası (`risk-agg-v2`)

1. Kurallar arasında en yüksek kazanır.
2. İki **farklı aileden** uyarı → `HIGH_RISK` (doğrulama). Aynı ailedeki kurallar
   birbirini doğrulayamaz.
3. Anomali skoru tek başına en fazla `WARNING`. Bir kural uyarısıyla birlikte ikinci
   kanıt sayılması için, uyarı veren ailelere ait özellik katkıları çıkarıldıktan sonra
   da eşiği geçmelidir (v2; v1 aynı gözlemi iki kez sayıyordu — EXP-004 §6). Kalitesi
   < 0.5 olan skor hiç sayılmaz.
4. `EMERGENCY` yalnızca panikten gelir ve **otomatik düşmez**; operatör çözer.
5. Operatörün `WARNING`/`HIGH_RISK` kararı süreli bir **taban** olur (varsayılan 120 dk);
   değerlendirme o süre içinde seviyeyi tabanın altına indiremez.

`HIGH_RISK`'e yükseliş operatör alarmıdır (`SafetyAlertRaised`); askı, ödeme veya
hesap üzerinde geri dönüşsüz hiçbir işlem yapmaz.

### 7. Anomali modeli AI servisindedir ve core'a porttan bağlanır

NLP/matching ile aynı desen: HTTP portu, kısa timeout (1,5 sn), yanıt yeniden
doğrulanır, 4xx `CONTRACT_MISMATCH` olarak ayrılır, hata yükseltilmez. Modele
türetilmiş sinyaller gider; koordinat yalnızca varış aşamasında ve yalnızca rota
tahmini için (iki nokta). Rota tahmini **Faz 7 routing portu** üzerinden yapılır;
ikinci bir rota alt sistemi yoktur. Rota sağlayıcısı düşerse ETA uydurulmaz.

Model öğrenilmiş değildir (`anomaly-deviation-v2`: sapma fonksiyonları + noisy-OR +
oturum geçmişi); bu açıkça belgelenir (R-61). Art arda 5 altyapı hatası istemcide devre
kesiciyi 30 sn açar: AI kesintisi izleyici turunu çağrı başına timeout kadar uzatmaz.

### 8. Değerlendirme: OKU → KARAR VER → YAZ

Okuma transaction'sız; AI çağrısı hiçbir bağlantı/kilit tutmadan; yazma kısa bir
transaction ve oturumu **taze** okur: arada kapandıysa sonuç atılır, arada panik
geldiyse `EMERGENCY` korunur. Zamanlanmış izleyici (`SKIP LOCKED` sahiplenme) telemetri
kesildiğinde de değerlendirmeyi sürdürür — boşluğu fark ettiren şey zamandır. Tur 20 sn
bütçelidir ve en fazla 5 oturumu eşzamanlı değerlendirir; bir oturumun hatası diğerlerini
durdurmaz.

### 9. Panik yalnızca PostgreSQL'e bağlıdır

Olay + oturum (`EMERGENCY`) + rezervasyon askısı (`SAFETY_HOLD` → ödeme donar) + audit +
outbox (`SafetyAlertRaised`) **tek transaction**. Panik ucunda hiçbir oran sınırı yoktur
(gerçek bir acil durumda reddedilen basış kabul edilemez; tekrar basış zaten yan etkisiz);
anomali/rota çağrılmaz. Kilit sırası booking → oturum (check-out ile deadlock olmasın);
deadlock/serileştirme hatası yeniden denenir. Askı bir savepoint içinde denenir:
durum makinesi reddederse panik **yine kaydedilir**. İdempotensi **kişi başınadır**:
aynı kişinin tekrar basışı yan etkisizdir (kilitsiz ön kontrolle döner); karşı tarafın
paniği ayrı, "doğrulayıcı" bir kayıt ve ayrı bir alarmdır — ilk (belki sahte) panik
ikinciyi yutamaz; askı kaldırılmış ama acil durum çözülmemişse karşı tarafın paniği askıyı
yeniden uygular. Operatör çözdükten sonra yeni panik kabul edilir. `PRE_SERVICE`'te
panik reddedilir (taraflar birlikte değildir; askı ucuz bir kötüye kullanım olurdu).
Etkin panik yalnızca onu başlatana gösterilir. Operatör, etkin acil durumu önce
çözmeden oturumu kapatamaz. Bildirim commit
sonrası en iyi çabadır (port); **hiçbir dış acil durum kurumuna entegrasyon yoktur**
(R-59).

### 10. API dar, iç mantık kapalı

Taraf görünümü risk seviyesi, kural, skor, geofence durumu ve koordinat içermez.
Operatör uçları RBAC'lidir; ham iz yalnızca `ADMIN`'e açıktır ve her okuma audit'lenir.

### 11. Retention bir silme işidir

Ham konum `retention_expires_at` (planlanan bitiş + 30 gün; panik, `DISPUTED` ya da
`HIGH_RISK`'e yükselişte kanıt süresi) sonra silinir; son konum silinir, hizmet noktası ~1 km'ye yuvarlanır. Olaylar ve
değerlendirmeler append-only'dir ve **koordinat taşımaz**; kalırlar. Süreler
`TODO(legal)`.

## Sonuçlar

- (+) Panik, AI/Redis/Pub/Sub kesintisinden etkilenmez (T-20); integration testiyle
  doğrulandı.
- (+) Kural ile model ayrı ölçülebilir; EXP-004 beş kolu karşılaştırır.
- (−) Eşzamanlı paniklerin kuyruk gecikmesi sıralıdan belirgin biçimde yüksek (R-54).
  Havuz 10 → 20 p95'i değiştirmedi: neden havuz değil; global audit kilidi (ADR-0013)
  hipotez olarak kalır.
- (−) Cihaz uykusu gerçek zamanlı olarak telemetri boşluğundan ayırt edilemez (R-55).
- (−) Eşikler ve model referans aralıkları sentetik veriyle seçildi (R-57, R-61, R-63).
- (−) v2 model, kuralların göremediği ince bileşimi yakalarken zararsız tekrarlarda
  yanlış uyarı üretir (EXP-004: N11 %30; R-71). Model yüksek risk recall'una katkı yapmaz.

## Alternatifler

- **Ayrı safety yaşam döngüsü (reddedildi):** iki kaynak ayrışırdı; check-out commit
  edilip telemetri kapısı açık kalabilirdi.
- **Oturumu booking servisinden ayrı çağrıyla ilerletmek (reddedildi):** ödeme ve
  matching yolları onu unutabilirdi.
- **Telemetri ucunda fail-closed oran sınırı (reddedildi):** Redis kesintisi toplu
  sahte alarm üretirdi.
- **Değerlendirmeyi ingest içinde senkron yapmak (reddedildi):** her telemetri isteği AI
  gecikmesini devralırdı.
- **Hareketsizlik kuralını hizmet sırasında GPS ile uygulamak (reddedildi, EXP-004
  tasarımında bulundu):** GPS daire içindeki hareketi göremez (R-62).
