# EXP-007: Performans Baseline ve Ölçüm Planı (Faz 14)

- Tarih: 2026-09-23
- Faz: 14
- Durum: **tamamlandı.** Ölçülenler: S-02, S-03, S-04, S-05, S-07, S-08, S-09, S-10,
  S-11, S-12. Ölçülmeyenler ve nedenleri: **S-01** (okuma ucu baseline — ayrı
  ölçülmedi; okuma yolları §10.5'teki sorgu profilinde ve S-02'nin kurulum
  adımlarında zaten index scan'de ve 0,2 ms altında görünüyor), **S-06** (çekirdeği
  `bookings.integration.spec.ts` T-05e ile kapsanıyor, §10.7) ve **S-11'in rota
  kolu** (dış rota servisi entegre değil — §10.10, R-96). Ayrıca kapanışta iki
  **ölçülebilir ama ölçülmemiş** kurtarma yolu tespit edildi: asılı kalan kimlik
  sağlayıcısı ve Postgres kesintisi/kurtarması (§10.10, §10.11 — R-98). Bölüm 1-9 ölçümden
  **önce** yazılmıştır (Faz 14 kuralı: metrik tanımı ve
  senaryo, sonuç görülmeden sabitlenir) ve sonradan sonuca uydurulmamıştır; §10
  sonuçları, §11 ölçüm sırasında bulunan sorunları ve düzeltmelerini taşır.
- Etiket: **local benchmark** — buradaki hiçbir sayı üretim/SLO iddiası değildir (§2, §8).

## 1. Amaç

Emek'in mevcut backend + event-driven sisteminin **performans sınırlarını** ve **arıza
davranışını** ölçmek; darboğazları kanıtla bulmak; yalnızca kanıtlanan darboğazları
düzeltmek.

Bu bir kapasite planlaması **değildir**. Üretim kapasitesi hakkında iddia üretmez
(bkz. §5 Limitations).

## 2. Ortam — "local benchmark"

Faz 13 gerçek GCP doğrulaması **açıktır** (R-93: hesap/faturalandırma/kimlik yok).
Bu nedenle bu fazdaki her sayı **local benchmark** etiketlidir ve Cloud Run / Cloud SQL /
Memorystore performansı hakkında **hiçbir** şey söylemez.

| Bileşen  | Değer                                                                        |
| -------- | ---------------------------------------------------------------------------- |
| Host     | Mac16,1 (Apple silicon), 10 vCPU, 16 GiB RAM, macOS 26.6.2                   |
| Node     | v22.23.2                                                                     |
| Postgres | 16.4 + PostGIS, Docker — **x86_64 imajı, emülasyon altında**                 |
| Redis    | 7.4.11, Docker                                                               |
| Uygulama | Nest uygulaması **test süreci içinde** (`createTestApp`), ayrı container yok |
| DB pool  | `DATABASE_POOL_MAX=10` (varsayılan)                                          |

**Emülasyon uyarısı:** Postgres container'ı Apple silicon host üzerinde x86_64 olarak
çalışır. CPU'ya bağlı veritabanı işleri (sıralama, join, PostGIS hesapları) gerçek
donanımda olacağından **belirgin ölçüde yavaştır**. Bu yüzden:

- **mutlak** latency değerleri üretim tahmini olarak kullanılamaz;
- **göreli** karşılaştırmalar (aynı ortamda before/after, ölçek eğrisi, darboğaz sırası)
  geçerlidir ve bu fazın asıl çıktısıdır.

Uygulama ile veritabanı **aynı makineyi paylaşır**: yük altında istemci, uygulama ve
veritabanı aynı 10 vCPU için yarışır. Bu, yüksek eşzamanlılıkta ölçülen latency'nin
gerçek sunucu-taraflı işlem süresinden fazla olacağı anlamına gelir; eşzamanlılık
eğrisi bu doygunluğu içerir ve öyle raporlanır.

## 3. Araç seçimi

`docs/testing/test-strategy.md` yük testi için "k6/Locust" öneriyordu. Bu fazda
**kullanılmıyor**; gerekçe:

- k6/Locust yerel makinede kurulu değil ve yeni bir runtime/binary bağımlılığıdır
  (CLAUDE.md §5: "gereksiz dependency eklenmez").
- Repoda **zaten** çalışan ve aynı işi yapan bir ölçüm deseni var:
  `services/api/scripts/exp-004-latency.ts` — gerçek Nest uygulamasını gerçek
  Postgres/Redis'e karşı ayağa kaldırır, deterministik fixture üretir, sonucu
  `docs/research/experiments/*.json` olarak yazar.
- HTTP dışı ölçümler (outbox, consumer, pool davranışı) zaten süreç içi erişim ister.

Karar: **mevcut desen genişletilir**, yeni framework eklenmez. Bu bir kısıttır ve
§5'te limitation olarak kaydedilir (dış istemci yok → ağ katmanı ölçülmüyor).

## 4. Metrik tanımları (ölçümden önce sabitlenmiştir)

Tanım muğlaklığı sonradan "iyi görünen metriği seçme"ye yol açtığı için burada kapatılır.

| Metrik                | Tanım                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `latency`             | İstemcinin isteği gönderdiği andan yanıtın tamamı alınana kadar geçen duvar saati süresi (ms). Uygulama içi süre değil, uçtan uca.     |
| `p50` / `p95` / `p99` | Doğrusal interpolasyonlu yüzdelik (`exp-004-latency.ts` ile aynı `quantile()`), **tüm** istekler üzerinden — başarısızlar dahil.       |
| `RPS`                 | Tamamlanan istek sayısı / ölçüm penceresi (ilk istek gönderimi → son yanıt), saniye. Ramp-up dahil; ayrı "steady state" iddiası yok.   |
| `error rate`          | HTTP ≥ 500 **veya** taşıma hatası olan isteklerin oranı. 4xx **hata değildir**: 409 çakışma ve 429 sınır, sistemin doğru davranışıdır. |
| `conflict rate`       | 409 (booking çakışması) oranı — ayrı raporlanır, error rate'e karıştırılmaz.                                                           |
| `timeout rate`        | İstemci tarafı 10 sn kesme sınırını aşan isteklerin oranı.                                                                             |
| `pool wait`           | `pg` havuzundan bağlantı beklerken geçen süre (ms) ve bekleyen istek kuyruğu tepe değeri.                                              |
| `cache hit rate`      | Redis `keyspace_hits / (keyspace_hits + keyspace_misses)`, ölçüm penceresi başı/sonu `INFO stats` farkı.                               |

**Doğruluk metrikleri** (performanstan ayrı, taviz verilmez):

| Metrik                  | Tanım                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `overbooking count`     | Aynı provider + çakışan zaman aralığı için `COMMITTED` sayılan booking sayısı − 1. **Beklenen: 0.** |
| `idempotency violation` | Aynı idempotency key ile birden fazla farklı booking üretilmesi. **Beklenen: 0.**                   |
| `invariant violation`   | State machine izin tablosunda olmayan bir geçişin kalıcılaşması. **Beklenen: 0.**                   |

## 5. Senaryolar

Her senaryo deterministik üretilir (sabit seed; rastgelelik yoksa seed de yoktur) ve
**synthetic** veridir — üretim verisi değildir, öyle raporlanmaz.

| No   | Senaryo                                                            | Ölçülen                                                    |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| S-01 | Okuma ucu baseline (tek istemci)                                   | p50/p95, darboğazsız referans                              |
| S-02 | Booking create — 100 / 250 / 500 eşzamanlı, **çakışmayan** slotlar | throughput, p50/p95/p99, error/timeout, pool, Redis        |
| S-03 | Booking create — N eşzamanlı, **aynı** provider+slot               | overbooking = 0, 409 oranı, DB constraint'in kaynak olduğu |
| S-04 | Aynı idempotency key, eşzamanlı tekrar                             | tek booking, tek yan etki                                  |
| S-05 | Redis down → booking                                               | correctness korunur mu, hangi uç degrade olur              |
| S-06 | Redis flush sonrası tekrar                                         | idempotency DB'den mi geliyor                              |
| S-07 | Safety telemetri yükü (R-64)                                       | paket INSERT/UPDATE maliyeti, partition davranışı          |
| S-08 | Panik yolu, telemetri yükü altında                                 | deterministik ve hızlı kalıyor mu (bozulmadan)             |
| S-09 | Matching/optimization ölçeği (R-16)                                | aday sayısı ↑ → latency, timeout/fallback oranı            |
| S-10 | Outbox + consumer yükü                                             | publish lag, işleme gecikmesi, retry, DLQ, duplicate       |
| S-11 | Graceful degradation matrisi                                       | AI / identity / routing / Pub/Sub down davranışı           |
| S-12 | Failure recovery                                                   | outbox kurtarma, lease bitişi, çift işleme                 |

## 6. Hipotezler (ölçümden önce)

Yanlış çıkarsa **belge düzeltilmez, sonuç yazılır**.

- **H-1:** Booking create'in darboğazı uygulama CPU'su değil, `EXCLUDE USING GIST`
  çakışma kontrolü ve pool doygunluğudur; `DATABASE_POOL_MAX=10` ile 250+ eşzamanlılıkta
  latency pool beklemesiyle **doğrusal üstü** artar.
- **H-2:** Aynı slot'a N eşzamanlı istekte tam olarak 1 booking oluşur; geri kalanı 409
  alır. Redis kilidi kapalıyken de bu geçerlidir (doğruluk kaynağı constraint).
- **H-3:** Safety telemetri yazma maliyeti paket başına sabittir (tek INSERT + tek UPDATE);
  `location_events` partition'ı doğru ayda yazar.
- **H-4:** Optimization latency aday sayısıyla süper-doğrusal artar ve zaman limiti
  devreye girerek fallback oranını yükseltir (R-16'nın açık bıraktığı ölçek sınırı).
- **H-5:** Redis down iken booking doğruluğu korunur; fail-closed olan uçlar (oran sınırı)
  isteği reddeder — bu bir arıza değil, tasarlanmış davranıştır (ADR-0008 §3).

## 7. SLO durumu

`docs/architecture/deployment.md` ve alarm politikalarındaki eşikler **tanımlı bir
SLO'dan gelmiyor** (R-87 / A-09, Faz 13'te açıkça varsayım olarak kaydedildi).

Bu nedenle bu fazda:

- ölçülen değer **baseline olarak kaydedilir**;
- gereken hedef **varsayım (assumption)** olarak, gerekçesiyle yazılır;
- hiçbir sonuç "hedef karşılandı" diye yorumlanmaz — karşılaştırılacak onaylı bir hedef
  yoktur. Gerçek SLO, gerçek ortam ve gerçek trafik profili olmadan belirlenemez; nedeni
  budur ve burada kayıtlıdır.

## 8. Limitations (baştan kabul edilen)

1. Tek makine, emülasyonlu x86_64 Postgres → mutlak sayılar taşınabilir değil.
2. Uygulama süreç içinde; gerçek ağ, TLS, load balancer ve Cloud Run soğuk başlangıcı yok.
3. Tek instance → çok-instance davranışı (süreç içi oran sınırı R-66, kilit yarışı) ancak
   kısmen ölçülebilir.
4. Pub/Sub emulator, gerçek Pub/Sub'ın lag/teslim dağılımını temsil etmez.
5. Synthetic dataset gerçek talep/coğrafya dağılımını temsil etmez.
6. Teslim **at-least-once**'tır; hiçbir sonuç exactly-once iddiasına dönüştürülmez.

## 9. Reproducibility

Her ölçüm: `_test` sonekli veritabanında, domain tabloları sıfırlanarak, sabit fixture
üreticisiyle çalışır. Komutlar ve ham JSON çıktıları sonuç bölümlerine eklenir.

## 10. Sonuçlar

Ham çıktı: `exp-007-booking-load.json`. Komut: `npm run perf:booking --workspace=@emek/api`.
**Etiket: local benchmark** (§2). Ölçüm, aşağıdaki §11 düzeltmesinden **sonra** alınmıştır.

### 10.1 S-02 — Booking create, artan eşzamanlılık

`created_*` sütunları yalnızca **201 dönen** isteklerin gecikmesidir. Gerekçe
§11.2'de (toplam RPS ve toplam p95 bu iş yükünde yanıltıcıdır).

**`booking/sn` sütunu, oran sınırı etkin olan satırlarda bir throughput değildir**
(Faz 14 review, M-1): `created` sayısı sınır tarafından tam 30'a çivilenmiştir ve
pencere, kalan **429'ların** boşalma hızıyla belirlenir. Bu yüzden sütun 100'de 106,9
iken 250'de 249,9'a çıkıp 500'de 195,6'ya düşer — rezervasyon kapasitesi hakkında
hiçbir şey değişmeden. Okunması gereken `30 / red-boşaltma penceresi`dir.

| Eşzamanlılık | Oran sınırı | Oluşan | 429 | 5xx | error rate | timeout | p50 (201) | p95 (201) | p99 (201) | booking/sn | havuz kuyruk tepe | overbooking |
| ------------ | ----------- | ------ | --- | --- | ---------- | ------- | --------- | --------- | --------- | ---------- | ----------------- | ----------- |
| 100          | etkin       | 30     | 70  | 0   | 0          | 0       | 252.2 ms  | 277.8 ms  | 279.2 ms  | 106.9      | 20                | 0           |
| 100          | süpürülmüş  | 30     | 70  | 0   | 0          | 0       | 75.0 ms   | 92.1 ms   | 93.1 ms   | 320.5      | 20                | 0           |
| 250          | etkin       | 30     | 220 | 0   | 0          | 0       | 85.1 ms   | 117.8 ms  | 119.1 ms  | 249.9      | 20                | 0           |
| 250          | süpürülmüş  | 30     | 220 | 0   | 0          | 0       | 88.3 ms   | 104.5 ms  | 105.5 ms  | 282.4      | 20                | 0           |
| 500          | etkin       | 30     | 470 | 0   | 0          | 0       | 111.5 ms  | 142.4 ms  | 144.3 ms  | 195.6      | 20                | 0           |
| 500          | süpürülmüş  | 60     | 440 | 0   | 0          | 0       | 149.6 ms  | 190.2 ms  | 192.3 ms  | 288.4      | 36                | 0           |

**Okunuşu:**

- **Üç seviyede de 5xx = 0, timeout = 0, overbooking = 0.** Düzeltme öncesi aynı yol
  %100 5xx üretiyordu (§11.1).
- **Oran sınırı etkinken oluşan rezervasyon sayısı her seviyede tam 30'dur** — yani
  `booking-create` sınırının kendisidir (30/60 sn). Tek kaynaklı yükte sistemin
  görünen tavanı uygulama değil, sınırdır. Bu bir arıza değil, tasarlanmış davranıştır.
- **Süpürülmüş turun `Oluşan` sütunu bir kapasite ölçüsü DEĞİLDİR** ve öyle
  okunmamalıdır. Mekanizma artık sayıyla bilinir (Faz 14 review, bkz. §11.8):
  süpürücü 100 ms'de bir sınır sayacını siler ve her silme **30 istek daha** açar,
  yani `Oluşan ≈ 30 × (patlama süresi / 100 ms)`. Patlama ne kadar hızlı biterse o
  kadar az süpürme sığar ve sayı o kadar **düşer**. Nitekim daha hızlı bir koşuda
  250/süpürülmüş 104'ten 30'a, 500/süpürülmüş 120'den 60'a indi — sistem
  yavaşladığı için değil, **hızlandığı** için. Bu sütun süpürücü kadansının
  artefaktıdır; anlamlı olan aynı satırdaki gecikme yüzdelikleridir.
- **Tek makineden bu tavan aşılamaz.** `booking-create` sınırı istemci IP'si
  başınadır (30/60 sn) ve `X-Forwarded-For` bilinçli olarak güvenilmez (R-53), yani
  tek kaynaklı bir yük üreticisi kendini birden çok istemci gibi gösteremez. Gerçek
  motor kapasitesi ancak gerçek ortamda, çok kaynaklı yükle ölçülebilir.
- Havuz bekleme kuyruğu tepe değeri 20'den 36'ya çıkıyor (`DATABASE_POOL_MAX=10`;
  önceki koşuda 82'ye kadar çıkmıştı — kuyruk derinliği de patlamanın süresine
  bağlıdır). Havuz doyuyor; fark, artık **kilitlenmemesi** ve isteklerin sırayla
  ilerlemesidir. H-1'in "pool doygunluğu darboğazdır" kısmı doğrulandı.

### 10.2 S-03 — Aynı sağlayıcı + aynı aralık (100 eşzamanlı)

| Ölçüm                 | Sonuç   |
| --------------------- | ------- |
| Oluşan rezervasyon    | **1**   |
| Çakışma (409)         | 29      |
| Oran sınırı (429)     | 70      |
| 5xx                   | **0**   |
| Overbooking (SQL ile) | **0**   |
| p95 (201)             | 37.2 ms |

Tek bir rezervasyon oluştuğu için `p50 = p95 = p99 = 37.2 ms`: bu bir yüzdelik
değil, **tek bir gözlemdir** (n=1) ve öyle okunmalıdır (Faz 14 review, M-8).

409/429 dağılımı koşudan koşuya oynar (önceki koşu: 59/40) çünkü patlama tek bir
sınır penceresine ne kadar sıkışırsa o kadar çok istek sayaca takılır. **Oynamayan**
şey iddianın kendisidir: oluşan rezervasyon her koşuda tam 1, overbooking 0.

H-2 doğrulandı: **tam olarak bir** rezervasyon oluşur, kalanı 409 alır, çakışan aktif
rezervasyon çifti sıfırdır. Doğruluğun kaynağı DB constraint'idir.

### 10.3 S-04 — Aynı idempotency key, 20 eşzamanlı tekrar

| Ölçüm                           | Sonuç   |
| ------------------------------- | ------- |
| Oluşan rezervasyon (DB)         | **1**   |
| Farklı booking id               | **1**   |
| Özgün 201                       | 1       |
| 409 (`IDEMPOTENCY_IN_PROGRESS`) | 19      |
| 5xx                             | 0       |
| p95 (201)                       | 26.2 ms |

**Bu bir defect değildir; tasarlanmış sözleşmedir.** `IdempotencyService.begin()`
tek bir `FIRST_REQUEST` verir; eşzamanlı çakışanlar `IN_PROGRESS` → 409 alır;
tamamlandıktan **sonra** gelen tekrarlar saklanmış yanıtı `idempotent-replay: true`
ile tekrarlar. Ölçüm sırasında ilk turda görülen "3× 201" tam olarak budur:
1 özgün + 2 tekrar. Idempotency ihlali **0**.

### 10.4 Redis

Booking create yolunda ölçüm penceresinde `keyspace_hits` ve `keyspace_misses`
**ikisi de 0**'dır: bu yol Redis'i **önbellek olarak kullanmaz**, yalnızca oran sınırı
sayacı (`INCR`) için kullanır. Dolayısıyla bu yol için "cache hit rate" **tanımsızdır**
ve hesaplanmış bir oran raporlamak yanıltıcı olurdu. Cache/lock/idempotency
kullanımının ayrı ayrı ölçümü S-05/S-06 ile birlikte yapılacaktır.

### 10.5 Veritabanı sorgu profili (kapsam §4)

Ham çıktı: `exp-007-db-profile.json`. Komut: `npm run perf:db --workspace=@emek/api`.

Boş tabloda `EXPLAIN` hiçbir şey öğretmez (planlayıcı her zaman seq scan seçer), bu
yüzden önce deterministik sentetik veri üretilir: **2.000 sağlayıcı, 2.000 müşteri,
14.000 müsaitlik penceresi, 50.000 rezervasyon**, sonra `ANALYZE`.

Profil **gerçek** sorguları ölçer: aday havuzu sorgusu `CANDIDATE_SQL` olarak dışa
aktarıldı ki kopyalanmış bir metin zamanla sürüklenip sessizce yanlış sorguyu
ölçmesin.

Her nokta **5 kez** ölçülür ve **medyan** raporlanır (Faz 14 review, M-4: tek
`EXPLAIN ANALYZE`, emülasyonlu ve paylaşılan bir container'da gürültüyü sonuç diye
raporlar). Dönen satır sayısı da yazılır ve **sıfır satır artık hata verir** (§11.3'ün
bir kez ısırdığı tuzak; review H-3 kodda karşılığı olmadığını gösterdi).

| Sorgu                      | Amaç                                     | Yürütme (medyan, n=5) | Min–max       | Plan    | Satır | Seq scan    |
| -------------------------- | ---------------------------------------- | --------------------- | ------------- | ------- | ----- | ----------- |
| `availability_window_lock` | Booking create: pencereyi bul ve kilitle | 0.01 ms               | 0.01–0.08     | 0.03 ms | 1     | yok         |
| `booking_conflict_check`   | Booking create: çakışma kontrolü         | 0.02 ms               | 0.02–0.04     | 0.07 ms | 1     | (boş tablo) |
| `candidate_retrieval`      | Matching: aday havuzu (PostGIS)          | **557.32 ms**         | 549.62–561.78 | 1.21 ms | 50    | (boş tablo) |
| `provider_capacity`        | Matching: taze günlük kapasite           | 0.02 ms               | 0.02–0.03     | 0.05 ms | 1     | yok         |
| `customer_booking_list`    | Müşterinin rezervasyon listesi           | 0.02 ms               | 0.01–0.02     | 0.02 ms | 20    | yok         |
| `outbox_dispatchable`      | Outbox yayın taraması                    | 0.01 ms               | 0.01–0.01     | 0.02 ms | 4     | (4 satır)   |

**Sonuç: tek baskın maliyet aday havuzu sorgusudur.** Diğer bütün sıcak yollar
0.1 ms'nin altındadır, hepsi index scan kullanır ve tekrarlar arasındaki oynama
ihmal edilebilir. Mutlak değerler koşudan koşuya oynar (önceki koşuda
`candidate_retrieval` 1066 ms ölçülmüştü); **oynamayan** şey mertebe farkıdır:
aday havuzu, diğer sıcak yollardan dört mertebe pahalıdır.

**Seq scan'ler yanıltıcıdır, index gerekçesi değildir.** `availability_exceptions`,
`skills` ve `provider_skills` üzerinde seq scan görünür; bu tablolar sentetik veri
kümesinde **boştur** (0 satır). Boş tabloda seq scan doğru plandır ve buraya index
eklemek ölçülmüş hiçbir şeyi iyileştirmezdi. Bu yüzden eklenmedi.

#### Aday havuzu ölçek eğrisi (R-16)

Maliyet toplam sağlayıcı sayısıyla değil, adresi **kapsayan** sağlayıcı yoğunluğuyla
büyür (eleme bilinçli olarak `LIMIT`'ten önce yapılır — sorgudaki gerekçeli yoruma
bakınız).

| Uygun sağlayıcı | Yürütme (medyan, n=5) | Min–max       | Satır | Bir öncekine göre   |
| --------------- | --------------------- | ------------- | ----- | ------------------- |
| 74              | 11.06 ms              | 10.80–11.94   | 50    | —                   |
| 185             | 21.49 ms              | 20.97–22.10   | 50    | ×1.94 (veri ×2.5)   |
| 370             | 41.20 ms              | 40.97–41.51   | 50    | ×1.92 (veri ×2)     |
| 740             | 84.05 ms              | 84.04–104.18  | 50    | ×2.04 (veri ×2)     |
| 1480            | **553.04 ms**         | 551.15–555.55 | 50    | **×6.58** (veri ×2) |

Her nokta gerçekten **50 satır** döndürüyor (boş sorgu ölçülmedi) ve tekrarlar
arasındaki yayılım dardır — yani diz gürültü değildir.

**~740 uygun sağlayıcıya kadar yaklaşık doğrusal; sonrasında keskin bir diz var.**
Diz **disk taşması değildir** — plandaki bütün sıralamalar bellekte
(`Sort Method: quicksort ... Memory`, `work_mem = 4MB`). Yani `work_mem` artırmak
bu dizi açıklamaz ve çözmesi beklenmemelidir.

**Bu ölçüm R-16'yı kapatmaz, sınırını ölçer.** Faz 7 ölçümü 90 sağlayıcı/30 talep
ölçeğindeydi; burada ölçülen, tek bir adres için aday havuzunun çıkarılmasıdır.
Optimizasyon motorunun (CP-SAT) artan aday sayısındaki davranışı ayrı ölçülmüştür
(§10.8, S-09) ve tersini gösterir: aday sınırı sabitken sağlayıcı nüfusu büyüdükçe
optimizasyon **hızlanır**. Yani yoğunlukta darboğaz burada ölçülen retrieval'dır.

**Sorgu bu fazda değiştirilmedi.** `LIMIT`'ten önce eleme yapmak bilinçli bir
**doğruluk** kararıdır (aksi hâlde havuz kullanılamaz sağlayıcılarla dolar ve 200 m
ötedeki uygun sağlayıcı hiç değerlendirilmez). Performans için bunu tersine çevirmek
doğruluğu takas etmek olurdu; Faz 14 kuralı böyle bir değişikliği ancak kanıtlanmış
bir güvenilirlik problemi gerekçelendirdiğinde kabul eder ve bugün öyle bir kanıt
yoktur. Ölçülen sınır kayda geçirilmiştir.

#### Fazlalık index kaldırıldı (tek index değişikliği)

`idx_availability_provider_slot`, `availability_provider_id_slot_excl` ile
**birebir aynıdır** (ikisi de `gist (provider_id, slot)`, ikisi de 1856 kB).
İkincisi EXCLUDE kısıtının index'idir ve düşürülemez; dolayısıyla fazlalık olan
elle eklenmiş birincisidir.

| Ölçüm                                  | Index varken | Index yokken               |
| -------------------------------------- | ------------ | -------------------------- |
| 5.000 satır INSERT (4 koşu ortalaması) | ~424 ms      | ~347 ms                    |
| Okuma planı                            | Index Scan   | Index Scan (kısıt index'i) |
| Okuma maliyet tahmini                  | 0.29..8.31   | 0.29..8.31                 |
| Index boyutu                           | 1856 kB      | —                          |

Okuma planı ve maliyeti **değişmiyor**, yazma ~%18 ucuzluyor.
Migration: `20260923160000_performance-indexes.js` (up/down doğrulandı).
**Bu fazda hiç index eklenmedi** — ekleme için kanıt üretilemedi.

### 10.6 Safety telemetri yükü (S-07 / S-08; R-64, R-66)

Ham çıktı: `exp-007-safety-load.json`. Komut: `npm run perf:safety-load --workspace=@emek/api`.

EXP-004'ten farkı: orası **tek istemcili gecikme** ölçüyordu ve açıkça "yük testi
değildir" diyordu (R-64'ün açık bıraktığı nokta). Burada hacim ve eşzamanlılık ölçülür.

**Ölçüm kurulumu notu:** telemetri asgari aralığı, şemanın izin verdiği **en küçük
değere** (5 sn) ayarlandı. Sebep: örnek, oturum başlangıcından sonra ve en fazla
`max_skew` (120 sn) ileride damgalanabilir; taze bir oturumda varsayılan 30 sn aralıkla
pencereye ~4 örnek sığar ve 20'lik paket hiç ölçülemez. Bu, örneğin **kabul edilme**
kriterini değiştirir; paket başına **yazma** maliyetini değiştirmez — ölçülen de odur.

#### S-07a — Paket boyutu ölçeği (H-3)

20 oturum, her paket boyutu için **taze** oturumlar.

| Paket | p50    | p95     | Kabul edilen örnek | Yazılan satır | Örnek başına p50 |
| ----- | ------ | ------- | ------------------ | ------------- | ---------------- |
| 1     | 6.8 ms | 16.2 ms | 20                 | 20            | 6.80 ms          |
| 5     | 7.1 ms | 8.6 ms  | 100                | 100           | 1.42 ms          |
| 10    | 6.5 ms | 8.4 ms  | 200                | 200           | 0.65 ms          |
| 20    | 6.5 ms | 9.7 ms  | 400                | 400           | 0.33 ms          |

**H-3 doğrulandı.** Paket gecikmesi boyuttan **bağımsız** olarak ~6.5-7.1 ms'te kalıyor;
örnek başına maliyet 6.80 ms'ten 0.33 ms'e düşüyor (**~20.6 kat**). Bu, ucun paket
başına tek INSERT + tek UPDATE yaptığı iddiasıyla tutarlıdır: maliyet örnek sayısıyla
değil, **istek sayısıyla** büyüyor. Kabul edilen örnek sayısı yazılan satır sayısına
birebir eşit (20/100/200/400) — yani ölçülen gerçekten yazma yoludur.

#### S-07b — Eşzamanlı telemetri

| Ölçüm                              | Sonuç               |
| ---------------------------------- | ------------------- |
| Eşzamanlı oturum                   | 20                  |
| Paket boyutu                       | 20                  |
| Pencere                            | 376 ms              |
| p50 / p95                          | 157.7 ms / 354.7 ms |
| HTTP 200 / diğer                   | 20 / 0              |
| Kabul edilen örnek / yazılan satır | 400 / 400           |
| Kabul edilen örnek/sn              | **1062.6**          |

Hız bilinçli olarak **kabul edilen** örnek üzerinden hesaplanır: reddedilen örnek
yazma maliyeti doğurmaz ve throughput gibi raporlanamaz.

#### S-07c — Partition davranışı (R-69)

| Partition                 | Satır |
| ------------------------- | ----- |
| `location_events_202609`  | 780   |
| `location_events_202610`  | 0     |
| `location_events_default` | **0** |

Bütün satırlar doğru aylık partition'a düştü; **DEFAULT partition boş**. R-69'un asıl
tehlikesi (DEFAULT'a düşen satırların yeni partition açılmasını engellemesi ve partition
düşürmeyle temizlenememesi) bu koşuda gerçekleşmedi. **R-69 kapanmadı:** gerçek hacimde
DELETE maliyeti ve uzun vadeli partition stratejisi ölçülmedi.

#### S-08 — Panik yolu telemetri yükü altında

| Ölçüm | Sonuç   |
| ----- | ------- |
| p50   | 9.8 ms  |
| p95   | 54.8 ms |
| max   | 88.4 ms |

20 oturum eşzamanlı 20'lik telemetri paketi gönderirken basılan panik, anomali servisi
**erişilemezken** p50 9.8 ms'te tamamlandı. Panik yolu ölçüm için **değiştirilmedi**;
deterministik ve ML'den bağımsız kalmaya devam ediyor (ADR-0008 §3).

#### R-66 — Süreç içi telemetri oran sınırı

70 denemeden **tam 60'ı** sınırı geçti, **10'u** 429 aldı: süreç içi, kullanıcı başına
60/dk sınırı tek instance'ta gerçekten uygulanıyor.

**R-66 kapanmadı ve kapanamaz:** sınır **instance başına** tutulur, N instance'ta toplam
sınır N katıdır. Bu ölçüm tek instance'ta davranışın doğruluğunu gösterir, çok-instance
davranışını değil — onun için gerçek bir çok-instance ortamı gerekir (R-93).

### 10.7 Bozulma davranışı — Redis erişilemez (S-05)

Regresyon testi: `test/degradation.integration.spec.ts` (3 test, yeşil). Redis
mock'lanmaz; adres erişilemez bir porta çevrilir — gerçek istemcinin gerçek hata yolu
izlenir.

| Senaryo            | Ölçülen davranış                                                    | Karar                                                        |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| Oran sınırlı uç    | **429 `RATE_LIMITED`** (fail-closed), gövdede altyapı sızıntısı yok | ADR-0003 gereği tasarlanmış                                  |
| `GET /health`      | **503**, `redis: down`, `postgres: up`                              | doğru: bir bağımlılığın düşmesi diğerini "down" göstermiyor  |
| `GET /health/live` | **200**                                                             | doğru: geçici Redis arızasında container yeniden başlatılmaz |

**Önemli ve rahat okunmaması gereken sonuç:** Redis kesintisi, oran sınırı taşıyan
**bütün uçları kapatır** — booking create dahil. Bu bir arıza değil, ADR-0003'ün
bilinçli fail-closed kararıdır; ama pratikte "Redis down = rezervasyon alınamaz"
demektir. Bu, kayda değer bir kullanılabilirlik bağımlılığıdır ve bir SLO tartışmasında
açıkça masada olmalıdır. Panik ucunda oran sınırı yoktur (ADR-0008 §3), dolayısıyla
Redis kesintisinden etkilenmez.

**Henüz ölçülmedi:** Redis erişilemezken booking create'in uçtan uca doğruluğu
(fail-closed olduğu için uç zaten kapalı) ve S-06 (flush sonrası idempotency) —
S-06'nın çekirdeği `bookings.integration.spec.ts` T-05e ile zaten kapsanıyor.

### 10.8 Optimizasyon ölçeği (S-09; H-4, R-16)

Ham çıktı: `exp-007-matching-scale.json`.
Komut: `cd services/ai && uv run python -m app.evaluation.matching.scale`.

EXP-002'den farkı: orası sabit üç zorluk profilinde **kalite** karşılaştırması
(baseline vs proposed) yapıyordu. Buradaki soru ölçektir: aday sayısı büyüdükçe
çalışma süresi, timeout ve fallback nasıl davranıyor?

Her ölçüm noktası **20 tohumla** çalıştırılır. Amaç fonksiyonu ve katsayılar
**değiştirilmedi**.

Tohum sayısı iki kez artırıldı ve **her ikisi de sonucu değiştirdi** (bkz. §11.5 ve
§11.7): tek tohumda p50 = p95 çıkıyordu, 5 tohumda `percentile` en-yakın-sıra
kullandığı için p95 fiilen **5 koşunun maksimumuydu**. Aşağıdaki sayılar 20 tohumla
üretilmiştir ve 5 tohumluk koşunun iki sonucunu **çürütür**.

#### A — Aday sayısı süpürmesi (asıl H-4 sorusu), 800 sağlayıcı sabit

| Aday üst sınırı             | Ort. aday | opt p50    | opt p95     | Fallback | Geçerli atama | Ort. atanan rank | Ort. ilk bacak |
| --------------------------- | --------- | ---------- | ----------- | -------- | ------------- | ---------------- | -------------- |
| 10                          | 10.0      | 4 ms       | 8 ms        | 0.0      | 0.778         | 1.00             | 772 m          |
| 20                          | 20.0      | 10 ms      | 13 ms       | 0.0      | 0.885         | 1.02             | 1064 m         |
| **50** (üretim varsayılanı) | 50.0      | 37 ms      | **61 ms**   | 0.0      | **0.987**     | 1.04             | 1782 m         |
| 100                         | 100.0     | 132 ms     | 289 ms      | 0.0      | **1.00**      | 1.07             | 2407 m         |
| 200 (şema üst sınırı)       | 200.0     | **675 ms** | **1483 ms** | 0.0      | 1.00          | 1.15             | 3296 m         |

**H-4 doğrulandı.** Aday sayısı 20 kat (10→200) artarken p50 169 kat (4→675 ms),
p95 185 kat (8→1483 ms) artıyor: açıkça süper-doğrusal. Bu sonuç 5 tohumluk koşuyla
aynı yöndedir ve tohum sayısından etkilenmemiştir.

**Çürütülen iki sonuç (5 → 20 tohum).** 5 tohumluk koşu şunları söylüyordu ve
ikisi de yanlıştı:

1. _"200 adayda p95 4225 ms, yani 5000 ms limitin %85'i; pay neredeyse tükendi."_
   O sayı bir p95 değil, **5 koşunun en kötüsüydü**. 20 tohumla p95 **1483 ms** —
   limitin **%30'u**. Alarm, dar örneklemin ürettiği bir artefakttı. Süper-doğrusal
   büyüme gerçektir; "pay tükendi" değildir.
2. _"Geçerli atama oranı 50 adayda zaten 1.00; 100 ve 200 hiçbir kalite kazancı
   sağlamıyor."_ 20 tohumla 50 adayda oran **0.987**'dir; 1.00'e ilk kez **100**
   adayda ulaşılır. Yani 100 aday, taleplerin son ~%1,3'ünü kapatır — kazanç
   küçüktür ama **sıfır değildir**. 200 adayın 100'e göre kazancı gerçekten sıfırdır.

**Kalite metrikleri artık doymayan ölçülerle birlikte raporlanıyor** (review bulgusu
H-2): `valid_assignment_rate` bir **kapsama** ölçüsüdür ve 1.0'da tavana vurar;
yalnızca ona bakarak "kalite kazancı yok" demek, tavana vurmuş tek metrikte kazanç
olmadığını söylemektir.

Doymayan metrikler kazanç **göstermiyor**, hatta ters yönde hareket ediyor: ortalama
atanan rank 1.00 → 1.15, ortalama ilk bacak 772 m → 3296 m, `recall@1` 0.54 → 0.09.
**Ama bunlar doğrudan "kalite düştü" diye okunamaz** ve burada öyle okunmuyor:

- `recall@k` daha büyük bir aday havuzunda ground-truth'u ilk k'ye koymayı ölçer;
  havuz büyüdükçe görev tanımı gereği zorlaşır. Havuz boyutuyla **kafa karıştırıcı**
  biçimde ilişkilidir.
- Ortalama ilk bacak, **kompozisyon** etkisi taşır: 100 adayda artık atanabilen
  talepler, tam olarak daha önce atanamayan **zor/uzak** taleplerdir; ortalamayı
  onlar yukarı çeker.

Dürüst özet: **kapsama 100 adayda tavana vurur; bunun ötesinde ölçülen hiçbir kazanç
yoktur ve gecikme sertçe artar.** 50 → 100 arasındaki seçim bir üründür, ölçüm değil:
~%1,3 kapsama karşılığında p50 37 → 132 ms (3,6 kat).

`MATCHING_CANDIDATE_LIMIT` varsayılanı **50**'dir ve şema **200'e kadar izin verir**
(`env.schema.ts`). Bu faz **değeri değiştirmez**: değiştirmek açık bir ürün/yapılandırma
kararıdır ve ölçüm tek başına onu vermez. Şemanın 200'e izin vermesi bir yapılandırma
tuzağı olarak **R-16'da açık kalır** — bugün hata üretmiyor çünkü varsayılan güvenli.

#### B — Sağlayıcı nüfusu süpürmesi (aday sınırı 20'de sabit)

| Sağlayıcı | Ort. aday | opt p50    | opt p95    | Fallback | Geçerli atama | Ort. ilk bacak |
| --------- | --------- | ---------- | ---------- | -------- | ------------- | -------------- |
| 40        | 20.0      | **128 ms** | **271 ms** | 0.0      | 0.898         | 5021 m         |
| 90        | 20.0      | 41 ms      | 73 ms      | 0.0      | 0.883         | 3485 m         |
| 200       | 20.0      | 16 ms      | 37 ms      | 0.0      | 0.882         | 2230 m         |
| 400       | 20.0      | 12 ms      | 15 ms      | 0.0      | 0.887         | 1547 m         |
| 800       | 20.0      | **11 ms**  | **14 ms**  | 0.0      | 0.885         | 1064 m         |

Sağlayıcı sayısı arttıkça optimizasyon **hızlanıyor** (128 → 11 ms, ~12 kat).
20 tohumla bu sonuç 5 tohumluktan **daha da nettir**. Sezgiye aykırı ama tutarlı:
aday sınırı sabit olduğu için optimizasyonun girdisi büyümüyor; bol arzda adaylar
talepler arasında neredeyse ayrık kümelerden gelir ve iyi bir çözüm hızla bulunur,
kıt arzda ise 30 talep aynı 40 sağlayıcıyı paylaşır, problem sıkı kısıtlanır ve
çözücü daha çok çalışır.

Kıtlığın bedeli yalnızca süre değildir: ortalama ilk bacak 40 sağlayıcıda 5021 m,
800'de 1064 m. Yani bol arz hem daha hızlı hem daha yakın atama üretir.

Alternatif açıklama (Python/OR-Tools ısınması) **elenmiştir**: betik önce aday
süpürmesini koşar, yani ısınma bedeli en hızlı noktada (`cand-10`, 4 ms) zaten
ödenmiştir; ayrıca `800/20` noktası iki süpürmede de aynı çıkar (11 ms ve 11 ms).

**Dolayısıyla CP-SAT için ölçek riski bolluk değil, kıtlıktır.**

Sistem seviyesindeki tablo için dikkatli olmak gerekir. Yoğunluk arttıkça
**veritabanı aday havuzu sorgusu** pahalılaşıyor (§10.5: 1480 uygun sağlayıcıda
553 ms), optimizasyon ise ucuzluyor (11 ms). Bu iki sayı **aynı ortamda ölçülmedi**:
ilki emülasyonlu x86 Postgres'te, ikincisi native ARM Python'da. §2'nin kuralı
gereği aralarında doğrudan oran kurulamaz. Söylenebilecek olan bir **yön**dür:
iki mertebelik fark emülasyon cezasıyla tersine dönecek kadar küçük değildir,
dolayısıyla yoğun bölgede darboğazın **retrieval** tarafında olması beklenir.
Kesin sıralama, aynı ortamda uçtan uca ölçüm ister (gerçek ortam — R-93).

**S-09 kapanışı.** Süpürülen değişken **aday üst sınırıdır**, nokta başına 20 tohum
vardır ve H-4 doğrulanmıştır. `MATCHING_CANDIDATE_LIMIT` ve CP-SAT amaç
fonksiyonu/katsayıları **değiştirilmemiştir**. Şemanın 200 adaya izin vermesi
kapatılmış bir sorun değil, **R-16 yapılandırma riski** olarak açık kalır — ama
gerekçesi düzeltildi: risk "p95 limitin %85'i" değil, "süper-doğrusal büyüme ve
100 adayın ötesinde ölçülen kazanç yokken 5 kat gecikme"dir.

### 10.9 Event boru hattı: lag ve throughput (S-10; R-43)

Ham çıktı: `exp-007-event-pipeline.json`.
Komut: `npm run infra:up:events && npm run perf:event-pipeline --workspace=@emek/api`.

Etiket: **local benchmark — Pub/Sub _emulator_**. Emulator gerçek Pub/Sub'ın ağ
gecikmesini, akış kontrolünü ve teslim dağılımını temsil etmez (§8/4). Buradaki
sayılar üretim lag'i hakkında **hiçbir** iddia üretmez; ölçülen, **bizim boru
hattımızın** (outbox claim → publish → subscriber → runner → consumer) kendi
maliyetidir.

Üç süre ayrı ayrı ölçülür ve birbirine karıştırılmaz: `enqueue → published`
(outbox yayıncısı), `published → processed` (teslim + tüketim), `enqueue → processed`
(uçtan uca).

| Parti | Yayın duvar süresi | Yayın throughput | `enqueue→published` p95 | `published→processed` p50 / p95 | Tüketim duvar süresi |
| ----- | ------------------ | ---------------- | ----------------------- | ------------------------------- | -------------------- |
| 50    | 868 ms             | 58 event/sn      | 820 ms                  | 29,5 / 52,5 ms                  | 17 ms                |
| 200   | 2977 ms            | 67 event/sn      | 2830 ms                 | 29,4 / 51,7 ms                  | 54 ms                |
| 500   | 7131 ms            | 70 event/sn      | 6743 ms                 | 27,4 / 49,5 ms                  | 4 ms                 |

**Tekrarlanabilirlik:** üç bağımsız koşu aynı şekli verdi (throughput 51/65/73,
61/71/72 ve 58/67/70 event/sn; `published→processed` p95 hepsinde 49–62 ms). Mutlak
değerler makine gürültüsüyle oynar, **oran** oynamaz: yayın süresi parti boyutuyla
doğrusal, tüketim süresi ise partiden neredeyse bağımsızdır. Tablo son koşuyu
(`exp-007-event-pipeline.json` içindeki kayıt) verir.

`consume_wall_ms`'in 4–67 ms arasında oynaması bir ölçüm değil bir **örtüşme**
artefaktıdır: tüketim penceresi yayınla çakışır, yani drain biterken mesajların çoğu
çoktan işlenmiştir. Anlamlı olan `published → processed` dağılımıdır, bu duvar süresi
değil.

**Ölçüm düzeltmesi (Faz 14 code review).** İlk iki koşuda tüm satırlar tek
transaction'da yazılıyordu ve `occurred_at` sütun varsayılanı `now()` — yani
**transaction başlangıcı** — olduğu için `enqueue → published` her satır için ekleme
döngüsünün tamamını da içeriyordu. Satır başına `clock_timestamp()`'a geçildi.
Ölçülen fark küçük çıktı (500'lük partide p95 6684 → 6743 ms, gürültü mertebesinde):
ekleme döngüsü yayın süresinin yanında ihmal edilebilirmiş. Düzeltme yine de
gereklidir — sayının **ne ölçtüğü** artık tanımıyla aynı.

Her üç partide de: yayınlanan = üretilen, işlenen = üretilen, **duplicate etki 0**,
DLQ 0, `FAILED` outbox satırı 0.

**Ana bulgu — tavanı koyan şey, outbox yayıncısının olayları sırayla göndermesidir.** 500 event'in
yayını 7131 ms sürerken, teslim + tüketim event başına p95 **49,5 ms**'dir ve yayın
penceresiyle **örtüşerek** ilerler: drain bittiğinde işlenecek neredeyse bir şey
kalmaz. İki taraf iki mertebe farklıdır. Neden yapısaldır, emulator'a özgü değil: `OutboxPublisher.dispatch`
event'leri **sırayla** işler — her event için bir `publish` **ve** bir `UPDATE`,
ikisi de beklenerek. Böylece instance başına throughput ≈ `1 / (event başına tur
süresi)`'dir; burada tur süresi 7131 ms / 500 = **~14 ms**.

**Bu turun içinde hangi bacağın baskın olduğu ölçülmedi** (Faz 14 review, H-4).
`publish` gidiş-dönüşü ile emülasyonlu Postgres'e yazılan `UPDATE` ayrı ayrı
zamanlanmadı; `metrics.publishSuccess({ latencyMs })` de transport süresini değil
`enqueue → published` toplamını kaydeder. Dolayısıyla burada kanıtlanan şey
**serileştirmenin kendisidir**, "Pub/Sub yavaş" ya da "Postgres yavaş" değil.
Serileştirme kanıtı koddadır ve emulator'dan bağımsızdır; gerçek Pub/Sub'da tur
süresi uzayacağı için tavanın **düşmesi** beklenir.

Bu, kapatılmamış bir risktir (R-95). Paralelleştirme mümkündür ama masum değildir:
`PubSubEventTransport` `orderingKey` kullanır (`{subjectType}:{subjectId}`) ve aynı
anahtar içindeki sıra korunmak zorundadır. Anahtarlar **arasında** paralellik
güvenlidir, anahtar **içinde** değildir. Bu yüzden burada yalnızca **ölçülmüştür**;
değişiklik ayrı bir tasarım kararıdır ve bu fazda yapılmamıştır.

`enqueue → published` p95'inin parti büyüdükçe artması aynı şeyin başka yüzüdür:
sıradaki son event, önündeki tüm event'lerin turunu bekler.

Throughput'un parti büyüdükçe hafifçe artması (58 → 67 → 70 event/sn) tur başına
sabit maliyetin (`claimBatch`, 50'lik turlar) amorti olmasıdır; 50'lik parti tek bir
tur olduğu için sabit maliyeti tam öder.

### 10.10 Bozulma maliyeti (S-11)

Ham çıktı: `exp-007-degradation.json`.
Komut: AI servisi ayaktayken `npm run perf:degradation --workspace=@emek/api`.

Bozulmanın **doğruluğu** zaten testlerle kapsanıyordu (matching T-16,
`degradation.integration.spec.ts`). Burada ölçülen o değil: bozulmanın **bedeli**.
Aynı fikstür, aynı istek (`POST /booking-requests/:id/match`), 15 istek, üç kol.

| Kol       | AI servisi                         | p50     | p95       | 2xx   | Bozulmuş | `algorithm_version`    |
| --------- | ---------------------------------- | ------- | --------- | ----- | -------- | ---------------------- |
| `healthy` | ayakta                             | 9,5 ms  | 19,6 ms   | 15/15 | 0        | `matching-v1`          |
| `refused` | bağlantı anında reddediliyor       | 7,2 ms  | 15,6 ms   | 15/15 | 15       | `fallback-distance-v1` |
| `stalled` | bağlantı kabul ediliyor, yanıt yok | 13,1 ms | 1053,3 ms | 15/15 | 15       | `fallback-distance-v1` |

Her kolda **bir ısınma isteği atılır** (Faz 14 review, M-8). Atılmadan önce
`healthy`/`refused` p95'leri 43,8 ve 41,9 ms görünüyordu; ısınma atılınca 19,6 ve
15,6 ms'ye indi — yani o p95'ler kuyruğu değil ilk isteğin havuz/plan bedelini
ölçüyordu. `stalled` kolu etkilenmedi (1045 → 1053 ms), çünkü orada baskın terim
zaman aşımı bütçesidir.

**Tekrarlanabilirlik:** düzeltme sonrası üç koşu aynı şekli verdi (`stalled` p50
14,3 / 11,9 / 13,1 ms; p95 1058,9 / 1045,1 / 1053,3 ms). Tablo son koşuyu
(`exp-007-degradation.json` içindeki kayıt) verir.

**Kol başına 15 ölçülen istek vardır**; p95 bu örneklem büyüklüğünde kaba bir
göstergedir. Buradaki iddia bir yüzdelik hedefi değil, **büyüklük mertebesi** farkıdır
(ms'ler ile saniyeler arası) ve o fark üç koşuda da aynıdır.

**Doğruluk her kolda korundu**: hiçbir istek hata dönmedi, bozulmuş sonuçlar
`degraded` işaretlendi ve ayrı `algorithm_version` ile saklandı.

**Bulgu 1 — "bağımlılık düştü" tek bir şey değildir.** Reddedilen bağlantı sağlıklı
yoldan bile biraz **ucuzdur** (7,2 ms'ye karşı 9,5 ms: motor işi hiç yapılmaz; fark
küçüktür ve tek başına bir sonuç değildir). Asılı kalan bağımlılık ise zaman aşımı
bütçesinin tamamını harcar — sağlıklı p50'nin ~110 katı. Ölçülmesi gereken, hızlı hata veren değil,
**sessizce asılı kalan** bağımlılıktır.

**Bulgu 2 — devre kesici yoktu (düzeltildi, §11.6).** İlk koşuda `stalled` kolunda
**her** istek bütçeyi ödedi: p50 **1038,2 ms**, p95 **1060,6 ms** — sağlıklı p50'nin
~75 katı. Devre kesici eklendikten sonra aynı ölçüm p50 **11,9–14,3 ms** verdi. **Ama bu p50
bir etki büyüklüğü olarak okunmamalıdır** (Faz 14 review, item 10): kaç isteğin
bütçeyi ödediği sabittir (5), oranı ise ölçümdeki istek sayısına bağlıdır — 15
istekte %33, 100 istekte %5, 5 istekte %100. Aynı nedenle p95 hâlâ ~1050 ms'dir ve
böyle olması beklenir.

Düzeltmenin **N'den bağımsız** ifadesi şudur: motor asılı kaldığında tam bütçeyi
ödeyen istek sayısı, sınırsız yerine **30 saniyelik pencere başına en çok 5**'tir.

**Ölçüm tuzağı (kaydedilmiştir).** İlk denemede pahalı arıza, yönlendirilemez bir
adresle (RFC 5737 `192.0.2.1`) üretilmeye çalışıldı. Bu makinede Node'un `fetch`'i
oraya ~35 ms'de düşüyor (rota yok) — yani kol, ölçmek istediği şeyi hiç ölçmüyordu
(o koşuda `stalled` yerine `blackhole` p50 6,4 ms görünmüştü). Kol, bağlantıyı
kabul edip hiç yanıtlamayan yerel bir TCP dinleyicisiyle değiştirildi.

| Bağımlılık             | Davranış                                  | Ölçüldü mü                                                                                                                            |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| AI (matching)          | fallback + `degraded`                     | ✅ yukarıda                                                                                                                           |
| Kimlik sağlayıcısı     | **503**, fallback yok (16/16)             | ⚠️ **kısmen**: p50 2,5 ms / p95 4,9 ms — ama ölçülen kol mock'un hızlı hatasıdır; **asılı kalan** kimlik sağlayıcısı ölçülmedi (R-98) |
| PostgreSQL             | —                                         | ❌ **hiç kol yok**: tek transactional doğruluk kaynağının düşmesi/geri gelmesi (havuz kurtarması, yeniden bağlanma) sınanmadı (R-98)  |
| Redis                  | oran sınırlı uçlar fail-closed 429        | ✅ §10.7                                                                                                                              |
| Pub/Sub                | outbox biriktirir, domain state kaybolmaz | ✅ `degradation.integration.spec.ts`                                                                                                  |
| Rota (Google Maps vb.) | `FallbackRouter` → kuş uçuşu, `degraded`  | ⚠️ **ölçülemedi**: kayıtlı tek sağlayıcı yerel `haversine`; dış rota servisi henüz entegre değil (R-96)                               |

### 10.11 Arıza ve kurtarma (S-12)

Ölçüm değil, **davranış sözleşmesi**: `test/failure-recovery.integration.spec.ts`
(6 test) ve `analytics.integration.spec.ts`'e eklenen 2 test. Hepsi yeşil. Zaman
beklenmez; kira/backoff pencereleri SQL ile geriye alınır.

| Mekanizma              | Doğrulanan davranış                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outbox kiralaması      | Sahiplenilen event kira süresince ikinci instance tarafından **alınamaz**; tam olarak bir yayın                                                                                                  |
| Outbox kurtarma        | Instance çökerse kira dolunca event **yeniden sahiplenilir**, kaybolmaz                                                                                                                          |
| Outbox deneme sınırı   | `OUTBOX_MAX_ATTEMPTS` dolunca `FAILED`; taşıma düzelse bile **kendiliğinden** yeniden denenmez                                                                                                   |
| Consumer geçici hata   | NACK + işaret **geri alınır** → yeniden teslim başarılı; tekrarlanan hatada yan etki hiç oluşmaz                                                                                                 |
| Consumer kalıcı hata   | ACK + DLQ; işaret **kalır** → yeniden teslim ikinci DLQ kaydı veya yan etki üretmez                                                                                                              |
| BigQuery export worker | Çöken worker'ın satırları kira dolunca **tam bir kez** export edilir; kira serbest bırakılır                                                                                                     |
| Mutabakat worker       | Yeniden başlatılan tur aynı uyuşmazlığı **yeniden kaydetmez**; iki tur da görünür kalır                                                                                                          |
| Ödeme komutu retry     | Zaten kapsanıyordu (`payments.integration.spec.ts`): belirsiz hatadan sonra **aynı** idempotency anahtarı yeniden kullanılır, kesin reddten sonra yeni anahtar üretilir — çift para hareketi yok |

**S-12 kapanışı.** Kurtarma kapsaması, **kalıcı durumu olan** mekanizmaların tamamı
için tamdır: outbox kiralaması/kurtarma/deneme sınırı, consumer geçici ve kalıcı hata
yolları, BigQuery export kirası, mutabakat turu ve ödeme komutu retry'ı. Her biri
"kaybolma yok + çift yan etki yok" çiftini ayrı ayrı doğrular; zaman beklenmez,
pencereler SQL ile geriye alınır, dolayısıyla testler deterministiktir.

**Kapsamın dışında kalan ve gerçekten ölçülmemiş tek kurtarma yolu PostgreSQL'dir**
(R-98). S-11'in bağımlılık kollarında AI, kimlik, Redis, Pub/Sub ve rota vardır;
Postgres yoktur. Bu, kurtarma senaryolarının dayandığı **zeminin** kendisidir: bütün
S-12 mekanizmaları "Postgres ayakta" varsayar. Kesinti ve geri gelme (bağlantı havuzu
kurtarması, yeniden bağlanma, yarıda kalan transaction'ların akıbeti) sınanmadı.
İkinci boşluk, S-11'deki **asılı kalan** kimlik sağlayıcısı koludur — §10.10'un kendi
bulgusu "asılı kalan bağımlılık hata verenden çok daha pahalıdır" olduğu için bu
boşluk, bilinen en pahalı arıza tipini kimlik yolunda ölçmemek anlamına gelir.

İkisi de **ölçülebilir**; ölçülmemeleri bir kapsam kararıdır, teknik engel değil
(rota kolunun aksine — R-96 entegrasyon olmadığı için gerçekten ölçülemez).

## 11. Ölçüm sırasında bulunan ve düzeltilen sorunlar

### 11.1 Havuz kendi kendine kilitlenmesi (R-94) — düzeltildi

**Belirti:** çakışmayan rezervasyonlarda bile, eşzamanlılık havuz boyutuna ulaştığında
isteklerin tamamı 5 sn sonra **500** dönüyordu.

**Kök neden (kanıt: yığın izi):** `createWithin` bir transaction bağlantısı tutarken
`addresses.findOwned` ve `catalog.priceFor` **aynı havuzdan ikinci bir bağlantı**
istiyordu (`uow.query` → `pool.query`). Uçuştaki istek sayısı `DATABASE_POOL_MAX`'a
ulaştığında her bağlantı, asla serbest kalmayacak ikinci bir bağlantıyı bekleyen bir
transaction tarafından tutuluyor:

```
Error: timeout exceeded when trying to connect
    at UnitOfWork.withTransaction (src/common/database/unit-of-work.ts:18)
    at BookingsController.create (src/bookings/bookings.controller.ts:41)
```

Bu **slot çakışmasından bağımsızdır**; ayırt edici test bilinçli olarak hiç çakışmayan
rezervasyonlar kullanır.

**Kök neden düzeltmesi:** bağlantı taşınır (`UnitOfWork.queryOn(client, ...)`).
Aynı sınıf üç yerde daha bulundu ve düzeltildi: `MatchingRepository.findProviderDisplayName`,
`PaymentsRepository.countCommands`, `SafetyRepository.ensureLocationPartition`.

**Sınıfın tekrar girmesi engellendi:** `AsyncLocalStorage` ile süren transaction
izlenir; transaction içinde havuz sorgusu çağrılırsa testte **hata fırlatılır**,
üretimde hata olarak loglanır. Bağlantı örtük olarak **alınmaz** — bu, transaction
dışında olması gereken bir okumayı sessizce içeri çekerdi.

**Before/after (aynı ortam, aynı test):**

| Ölçüm                                        | Önce                  | Sonra  |
| -------------------------------------------- | --------------------- | ------ |
| 14 eşzamanlı **çakışmayan** rezervasyon, 5xx | 14                    | **0**  |
| 100 eşzamanlı aynı slot, oluşan rezervasyon  | 0                     | **1**  |
| 100/250/500 eşzamanlı, 5xx                   | (ölçülemedi)          | **0**  |
| `booking-concurrency` paketi süresi          | 14.2 sn (timeout'lar) | 5.6 sn |

**Regresyon:** `test/booking-concurrency.integration.spec.ts` (2 test),
`src/common/database/unit-of-work.spec.ts` (5 test).

### 11.2 İki metrik tuzağı — raporlama düzeltildi

İlk koşuda ham **RPS** 250 eşzamanlılıkta 1166 görünüyordu; oysa aynı pencerede
yalnızca 60 rezervasyon oluşmuştu. Ham RPS ve toplam p50/p95, yüksek eşzamanlılıkta
çoğunluğu oluşturan **ucuz 429 reddini** sayıyor: biri hızı olduğundan yüksek, diğeri
gecikmeyi olduğundan düşük gösteriyordu. Harness `created_p50/p95/p99` ve
`created_per_second` ekleyecek şekilde düzeltildi ve **ölçüm baştan tekrarlandı**.

### 11.3 Profil ilk koşuda sıfır satır ölçtü (düzeltildi)

Aday havuzu sorgusu ilk profilde 0.19 ms göründü. Sebep performans değil, **sorgunun
hiçbir satır döndürmemesiydi**: `identity_records` seed edilmediği için her sağlayıcı
`ir.verification_status = 'VERIFIED'` koşulunda eleniyordu. Sıfır satır döndüren bir
sorgunun süresi hiçbir şey ölçmez.

Düzeltildikten sonra aynı sorgu **1066 ms** ölçtü — yani ilk sonuç, sistemi olduğundan
~5600 kat hızlı gösteriyordu. Profil çıktısına bu yüzden `Actual Rows` kontrolü
eklendi; her ölçümde sorgunun gerçekten satır döndürdüğü doğrulanır.

### 11.4 Safety ölçümü ilk koşuda yazmayan yolu ölçtü (düzeltildi)

İlk safety koşusu "734 örnek/sn" raporladı ama aynı koşuda `rows_written = 0` idi.
Sebep: **HTTP 200, örneğin saklandığı anlamına gelmez.** Uç, paketi kabul edip her
örneği ayrı ayrı doğrular ve `accepted`/`rejected` sayılarını gövdede döndürür. Sıra
numarası sayacı turlar arasında sıfırlandığı için örnekler monotonluk kuralına takılıp
reddediliyordu; ölçüm de yazma değil **reddetme** maliyetini ölçüyordu.

Ayrıca oturum başına telemetri bütçesi sınırlıdır (asgari aralık + azami yaş), yani tek
oturum kümesi bütün fazlara yetmez. Harness düzeltildi: her faz **taze oturumlarla**
çalışır, sıra numarası oturum başına taşınır, ve hiç satır yazılmadıysa ölçüm sessizce
raporlanmak yerine **hata fırlatır**.

Bu, §11.3'teki sıfır-satır tuzağının ikinci örneğidir. Ortak ders: bir ölçüm, ölçtüğünü
iddia ettiği işin gerçekten yapıldığını **kanıtlamadan** raporlanmaz.

### 11.5 Ölçek ölçümü ilk iki koşuda yanlış değişkeni değiştirdi (düzeltildi)

İlk ölçek koşusunda yalnızca **sağlayıcı sayısı** büyütüldü ve optimizasyon süresi
_düşüyordu_ — "H-4 çürütüldü" gibi okunabilirdi. Çıktıdaki `mean_candidate_count`
her boyutta tam **20.0** olduğu için bu okuma yanlış olurdu: senaryo üreticisi talep
başına en fazla `candidates_per_demand` (varsayılan 20) aday verir, yani
**optimizasyonun girdisi hiç büyümemişti**. Ölçüm, H-4'ün sorduğu şeyi sınamıyordu.

Ayrıca ilk koşuda boyut başına tek tohum vardı ve p50 ile p95 birebir aynı çıkıyordu;
tek örnekten yüzdelik raporlanamaz. Tohum sayısı 5'e çıkarıldı.

Düzeltilmiş ölçüm doğru değişkeni (aday üst sınırı) süpürdüğünde H-4 **doğrulandı**.
Ders, §11.3 ve §11.4 ile aynı ailedendir: bir ölçüm, değiştirdiğini iddia ettiği
değişkeni gerçekten değiştirdiğini **kanıtlamadan** raporlanmaz.

### 11.6 Matching istemcisinde devre kesici yoktu (düzeltildi)

S-11 ölçümü gösterdi ki karar motoru **asılı kaldığında** (bağlantı kabul ediliyor,
yanıt hiç gelmiyor) her eşleştirme isteği zaman aşımı bütçesinin tamamını ödüyordu:
p50 1038 ms, sağlıklı p50'nin ~75 katı. Sonuç zaten bozulmuş moda düşecekti —
kullanıcı bu bedeli **her istekte yeniden** ödüyordu.

Aynı sorun Faz 8'de anomali istemcisinde bulunup çözülmüştü (`HttpAnomalyClient`:
5 hata → 30 sn). `HttpMatchingClient` aynı deseni almıyordu. Aynı desen eklendi:

- yalnızca **altyapı** hataları (`TIMEOUT`, `TRANSPORT`) devreyi açar;
- sözleşme hatası (`CONTRACT_MISMATCH`) ve geçersiz yanıt (`INVALID_RESPONSE`)
  **açmaz** — onlar kesinti değil şema ayrışmasıdır ve susturulmamalıdır;
- araya giren bir başarı sayacı sıfırlar;
- devre açıkken çağrı hiç yapılmaz, sonuç `CIRCUIT_OPEN` nedeniyle `UNAVAILABLE`
  olur ve serviste yine `ENGINE_UNAVAILABLE` olarak kaydedilir (bozulma
  muhasebesi değişmez).

Ölçülen etki: `stalled` kolunda p50 1038,2 ms → **11,9–14,5 ms** (üç koşu). p95
yüksek kalır ve kalmalıdır: devre açılmadan önceki 5 istek bütçeyi öder. Etkinin
**N'den bağımsız** ifadesi — ölçümdeki istek sayısına göre değişmeyen tek ifade —
şudur: tam bütçeyi ödeyen istek sayısı sınırsız yerine **30 sn pencere başına en
çok 5**'tir.

Birim testler: `http-matching.client.spec.ts` (+4 test).

### 11.7 Tohum sayısı yine yetersizdi: p95 aslında "5 koşunun maksimumu"ydu

§11.5 tohum sayısını 1'den 5'e çıkarmıştı. Faz sonu performans review'u bunun da
yetmediğini gösterdi: `metrics.percentile` **en-yakın-sıra** kullanır, dolayısıyla
n = 5 için p95 → `ceil(0.95 × 5) − 1 = 4`, yani dizinin **en büyük** elemanı.
Rapor edilen her "opt p95" fiilen 5 koşunun maksimumuydu.

Tohum sayısı 20'ye çıkarıldı (p95 → 18. sıra, gerçek bir üst kuyruk ölçüsü) ve
§10.8 yeniden koşturuldu. Sonuç, iki iddiayı **çürüttü**:

| İddia (5 tohum)                                | 20 tohumla gerçek                               |
| ---------------------------------------------- | ----------------------------------------------- |
| 200 adayda p95 4225 ms = zaman limitinin %85'i | p95 **1483 ms** = limitin **%30'u**             |
| Geçerli atama 50 adayda zaten 1.00             | 50 adayda **0.987**; 1.00'e 100 adayda ulaşılır |

İkincisi daha önemlidir çünkü ondan türetilen "100 ve 200 aday hiçbir kalite kazancı
sağlamıyor" cümlesi de düşer: 100 aday taleplerin son ~%1,3'ünü kapatır. 200'ün
100'e göre kazancı gerçekten sıfırdır.

Aynı review, `scale.py`'nin `MatchingReport`'ta zaten hesaplanan **doymayan** kalite
metriklerini (`recall_at`, `acceptance_rate`, `mean_assigned_rank`,
`mean_first_leg_meters`) çıktıya yazmadığını da buldu. Yazıldılar; §10.8 artık
kapsama metriğinin tavana vurmasıyla "kalite kazancı yok" sonucunu karıştırmıyor.

**Ders, §11.5'inkinin tekrarı değil bir katmanı:** yüzdelik raporlamak için yalnızca
"birden çok örnek" yetmez; örneklem, istenen yüzdeliğin **hesaplanabileceği** kadar
büyük olmalıdır. Aksi hâlde p95 sessizce maksimuma çöker ve en gürültülü tek koşu
yük taşıyan bir cümleye dönüşür.

### 11.8 "Süpürülmüş" kolun `Oluşan` sayısı bir artefakttır (kayda geçirildi)

Güvenlik review'u `perf-booking-load.ts`'teki `flushdb()` çağrılarını kaldırttı
(§ aşağıda) ve betik yeniden koşturuldu. S-02'nin **süpürülmüş** kolundaki `Oluşan`
sayısı belirgin biçimde düştü: 250'de 104 → 30, 500'de 120 → 60.

İlk bakışta bir regresyon gibi görünür; değildir. Aynı koşuda **bütün gecikmeler de
düştü** (250/süpürülmüş p95 632,6 → 104,5 ms) ve patlama süresi 648 ms'den 106 ms'ye
indi. Mekanizma şudur: süpürücü 100 ms'de bir sınır sayacını siler, her silme 30
istek daha açar, dolayısıyla

```
Oluşan ≈ 30 × (patlama süresi / 100 ms)
```

Yani sistem **hızlandıkça** bu sayı **düşer**. Ölçtüğü şey motor kapasitesi değil,
süpürücünün kaç kez fırsat bulduğudur — kendi kendine gönderme yapan bir metrik.

Bu fazda düzeltilmedi ve **düzeltilemez**: `booking-create` sınırı istemci IP'si
başınadır, sınır değeri koda gömülüdür (`@RateLimit({ limit: 30, windowSeconds: 60 })`,
yapılandırmadan gelmez) ve `X-Forwarded-For` bilinçli olarak güvenilmezdir (R-53).
Tek makineden, tek IP'den üretilen yük bu tavanı aşamaz. Yapılan şey, metriği
**geçersiz ilan edip** nedenini yazmaktır; §10.1'deki okuma buna göre düzeltildi.

Doğruluk iddiaları bu oynamadan etkilenmez ve her koşuda aynıdır: 5xx = 0,
timeout = 0, overbooking = 0, S-03'te tam 1 rezervasyon, S-04'te tam 1 booking id.

### 11.9 Aynı slotta deadlock: 409 yerine 500 (R-97) — düzeltildi

**Belirti:** faz kapanışında tam integration koşusu **4 koşunun 2'sinde** düştü;
`booking-concurrency` paketinde 15 eşzamanlı aynı-slot isteğinin **13'ü 500** döndü.
Aynı test **tek başına koşarken her zaman geçiyordu**.

**Kök neden (kanıt: log yığın izi):**

```
error: deadlock detected
    at BookingsService.createWithin (src/bookings/bookings.service.ts:182)
```

Havuz tükenmesi değildir (R-94 ayrı ve kapalı). Mekanizma: `isAvailableLocked` tüm
eşzamanlı transaction'larda **aynı** `availability` satırını `FOR SHARE` ile kilitler;
ardından her transaction `bookings` üzerindeki EXCLUDE constraint'inde diğerlerinin
commit/abort'unu bekler. Paylaşılan kilit + karşılıklı constraint beklemesi bir kilit
döngüsü kurar ve Postgres kurbanı `40P01` ile düşürür. `translateWriteError` yalnızca
`23P01` ve `23514` tanıyordu, dolayısıyla `40P01` ham hata olarak 500'e dönüşüyordu.

**Neden yalnızca birlikte koşarken:** diğer paketlerin yükü zamanlamayı kaydırıyor ve
döngünün kurulma penceresini büyütüyor. Arıza tek başına koşan testte **görünmez**;
bu yüzden "flaky test" değil, **gizlenmiş bir üretim hatasıdır**.

**Düzeltme:** transaction'ın **sahibi** olan `BookingsService.create`, `40P01`/`40001`
hatalarında transaction'ı en çok 3 kez yeniden dener. Desen projede zaten vardı
(`PanicService`, aynı SQLSTATE kümesi). `createWithin` çağıranın transaction'ını
aldığı için orada yeniden **denenmez**: o noktada transaction zaten iptal edilmiştir
ve yeniden denemek çağıranın işini bozardı.

Deadlock kurbanı **çakışma kanıtı değildir**, bu yüzden 409'a çevrilmedi: gerçek
çakışma varsa yeniden denemede `23P01` oluşur ve doğru yanıt olan 409 üretilir.

**Kanıtın sınırı (dürüstlük notu).** Düzeltmeden sonra 5 tam integration koşusu yeşil
geçti, ama o koşuların **hiçbirinde retry tetiklenmedi** (`booking.create.retry` = 0).
Yani bu beş koşu, flake'in nüksetmediğini gösterir; düzeltmenin **deadlock altında
çalıştığını göstermez**. Gerçek deadlock deterministik olarak üretilemediği için
yeniden deneme **sözleşmesi** birim testle sabitlendi
(`src/bookings/bookings.service.spec.ts`, 5 test): `40P01` ve `40001` yeniden denenir,
`23P01` ve alakasız hatalar **denenmez**, ısrarlı deadlock 3 denemede yüzeye çıkar.
Test vacuous değildir: `MAX_CREATE_ATTEMPTS = 1` yapıldığında 3'ü düşer.

### 11.10 Log tabanlı metriklerin tamamı ölü filtreye bağlıydı (R-92) — düzeltildi

R-92 bu sürüklenmeyi bir **olasılık** olarak kaydetmişti. Faz kapanışında statik
olarak kontrol edildi ve **mevcut durum** olduğu görüldü.

`monitoring.tf`'teki dört log tabanlı metriğin tamamı `jsonPayload.event` alanına
filtreliydi. Kod bu alanı **hiçbir yerde yazmıyor**: `grep`, uygulamanın yalnızca
`jsonPayload.metric` yazdığını gösteriyor (`EventMetrics`, `SafetyMetrics`).

| Metrik                       | Filtre                                        | Gerçek                         | Sonuç                 |
| ---------------------------- | --------------------------------------------- | ------------------------------ | --------------------- |
| `safety-panic`               | `event="safety.panic"`                        | `metric="safety.panic.raised"` | alan **ve** ad yanlış |
| `reconciliation-discrepancy` | `event="reconciliation.discrepancy"`          | log **hiç yazılmıyordu**       | kaynak yok            |
| `audit-chain-broken`         | `event="audit.chain_broken"`                  | log var, **adlandırılmamış**   | kaynak yok            |
| `worker-failure`             | `event=~"^(outbox\|consumer\|dead_letter)\."` | `metric=~"^event\..."`         | alan **ve** ad yanlış |

Yani panik ve audit zinciri kopukluğu alarmları dahil **dördü de kalıcı olarak sıfır**
üretecekti. Bu bir performans bulgusu değildir ama Faz 14'ün kapsamındadır: ölçülemeyen
bir sistemin güvenilirliği hakkında iddia üretilemez.

Yapılanlar: filtreler gerçek alana ve gerçek adlara bağlandı; audit zincir kopukluğu ve
mutabakat farkı logları sabit `metric` adlarıyla adlandırıldı.

**Kalan:** eşleşme **kod okumasıyla** doğrulandı, gerçek log akışına karşı değil.
`terraform validate` bu makinede çalıştırılamadı (terraform CLI kurulu değil).
R-92 bu yüzden **açık kalır**.

### 11.11 `UnitOfWork.query` fail-open davranışı — incelendi, korundu

Üretimde `query()` süren bir transaction içinde çağrılırsa isteği **düşürmez**, hata
olarak loglar ve devam eder; testte fırlatır. Bu asimetri kapanışta yeniden incelendi.

**Korundu.** Değiştirmek için ortaya konan tek gerekçe "testle üretim aynı davransın"
tutarlılığıydı; bu kozmetiktir ve bedeli gerçektir: üretimde fırlatmak, bugün yalnızca
kapasite kaybettiren bir durumu **müşteriye dönük 500'e** çevirirdi. R-94'ün ölçülen
şekli de bunu destekler — belirti hata değil, sessiz yavaşlamaydı.

**Ama fail-open'ın bedeli görünürlüktür:** log okunmazsa kapasite sessizce kaybolur.
Gözlemlenebilirlik bağlanması mimaride **zaten destekleniyordu** (sabit adlı `metric`
alanı + Cloud Logging log tabanlı metrik), yani çapraz kesen bir refactor gerekmedi.
Eklenenler: `metric: 'db.pool.nested_connection'` alanı, `*-pool-nested-connection`
log tabanlı metriği ve alarm politikası. Metrik adı birim testle sabitlendi
(`unit-of-work.spec.ts`) — ad sessizce değişirse alarm sıfıra düşerdi.

Bilinen sınır değişmedi: `AsyncLocalStorage` bağlamı fire-and-forget bir işe taşınırsa
yanlış pozitif üretebilir (bugün böyle bir çağrı yolu yok; kodda yorumlanmıştır).

### 11.12 Doğrulanan/çürütülen hipotezler

| Hipotez                           | Sonuç                                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-1 (darboğaz pool doygunluğu)    | **Kısmen doğrulandı.** Havuz gerçekten doyuyor (kuyruk 82'ye çıkıyor), ama asıl bulgu beklenenden ağırdı: doygunluk değil, **kilitlenme**. Düzeltme sonrası doygunluk doğrusal yavaşlama olarak görünüyor, hata olarak değil. |
| H-2 (aynı slot → 1 booking)       | **Doğrulandı** (S-03: 1 oluştu, 0 overbooking).                                                                                                                                                                               |
| H-5 (fail-closed sınır davranışı) | **Doğrulandı.** Oran sınırının bağlayıcı tavan olduğu ve Redis erişilemezken oran sınırlı uçların 429 ile fail-closed davrandığı ölçüldü (§10.7).                                                                             |

**H-3 doğrulandı** (S-07a: paket gecikmesi boyuttan bağımsız, örnek başına maliyet
~20.6 kat düşüyor; partition doğru, DEFAULT boş).

**Hipotez dışı, S-10/S-11'de ölçülen iki yapısal bulgu:** (1) event boru hattının
darboğazı Pub/Sub değil, outbox yayıncısının **sıralı** gönderimidir (§10.9, R-95);
(2) bir bağımlılığın "düşmesi" tek bir şey değildir — asılı kalan bağımlılık, hata
verenden ölçülebilir biçimde çok daha pahalıdır (§10.10).

**H-4 doğrulandı** (S-09-A, 20 tohum: aday sayısı 20 kat artarken optimizasyon p50
169 kat, p95 185 kat artıyor — süper-doğrusal). 200 adayda p95 **1483 ms**, yani
5000 ms'lik zaman limitinin **%30'u**; fallback oranı her noktada 0.0. Bu fazın
başında raporlanan "%85" rakamı 5 tohumluk geçersiz koşudan geliyordu (§11.7).
Ancak beklenmeyen bir bulgu eklendi: **sağlayıcı nüfusu** arttıkça optimizasyon hızlanıyor (S-09-B) —
ölçek riski bolluk değil kıtlıktır ve sistem darboğazı optimizasyonda değil
retrieval'dadır.
