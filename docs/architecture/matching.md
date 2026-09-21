# Matching, Ranking ve Optimization (Faz 7)

Bu doküman Emek'in karar motorunu anlatır: bir hizmet talebinin nasıl sağlayıcıya
dönüştüğünü, hangi kararın nerede verildiğini ve neyin **ölçüldüğünü**.

Bağlayıcı kararlar: [ADR-0007](adr/0007-llm-does-not-decide.md) (LLM seçmez),
[ADR-0012](adr/0012-research-versioning.md) (sürümleme),
[ADR-0018](adr/0018-matching-decision-chain.md) (Faz 7 karar zinciri).
Ölçüm: [EXP-002](../research/experiments/exp-002-matching-baseline-vs-optimized.md),
[EXP-003](../research/experiments/exp-003-confidence-calibration.md).

## 1. Zincir

```
booking_request
  → candidate retrieval   (core, SQL/PostGIS)      → aday havuzu + özellik vektörü
  → hard constraints      (AI + core, deterministik) → geçersiz adaylar elenir
  → scoring               (AI, sürümlü ağırlıklar)   → 6 bileşen, her biri [0,1]
  → ranking               (AI, deterministik)        → sıra + açıklama
  → optimization          (AI, OR-Tools CP-SAT)      → küresel atama + takvim
  → doğrulama             (core)                     → ihlalli atama düşer
  → booking + karar kaydı (core)                     → booking_match_results
```

**Hangi karar nerede veriliyor** sorusunun tek cevabı vardır: motor bir **öneri**
üretir, sonucu yazan core'dur. Motorun döndürdüğü her atama core'un kendi kısıt
değerlendirmesinden geçer; geçmezse atama düşer ve sayaca yazılır.

## 2. Candidate retrieval (core)

Tek SQL sorgusu (`MatchingRepository.CANDIDATE_SQL`). Erişim yolu:

| Adım       | Kaynak                             | Neyi daraltır                                              |
| ---------- | ---------------------------------- | ---------------------------------------------------------- |
| `eligible` | `provider_services` + GIST indeksi | hizmeti sunan **ve** bölgesi adresi kapsayan sağlayıcılar  |
| `base`     | `provider_service_areas`           | sağlayıcının referans noktası (bölgelerin ağırlık merkezi) |
| `measured` | `ST_Distance`                      | mutlak mesafe sınırı                                       |
| `free`     | multirange farkı                   | müsaitlik − istisna − aktif rezervasyon                    |
| `LIMIT`    | mesafeye göre sıralı               | en yakın N aday                                            |

Üç tasarım kararı:

- **Filtreleme veri katmanındadır** (ADR-0003). 10.000 sağlayıcıyı uygulamaya çekip
  mesafe hesaplamak yerine GIST indeksli `ST_Intersects` sorgusu çalışır.
- **N+1 yoktur.** Yetkinlikler ve müsaitlik pencereleri aynı sorguda JSON olarak
  toplanır; aday başına ayrı sorgu 50 adaylık havuzda 150 gidiş-dönüş demekti.
- **Müsaitlik çıkarma ile hesaplanır.** `range_agg(availability) − exceptions −
bookings`, talep penceresiyle kesiştirilir. "Çakışan rezervasyonu olan sağlayıcıyı
  tamamen ele" kuralı, sabah iki saatlik işi olan sağlayıcıyı tüm gün için elerdi.

Sağlayıcının nokta konumu **saklanmaz**: referans noktası, adresi kapsayan hizmet
bölgesinin ağırlık merkezidir. Ev adresi toplamak, karar için gerekli olmayan bir
kişisel veri toplamak olurdu.

İki tasarım detayı bu seçimin sonucudur:

- **Birleşimin değil, kapsayan bölgenin merkezi.** Tüm bölgelerin birleşiminin
  merkezi alınsaydı, iki uzak bölgede çalışan bir sağlayıcının merkezi ikisinin de
  dışına düşerdi: adres bir poligonun tam içindeyken sağlayıcı "çok uzak" diye
  elenebilirdi.
- **Mesafe, sağlayıcının kendi beyanına dayanır** (R-51). Doğrulanmış bir konum yok;
  sağlayıcı küçük bir daireyi müşteri yoğunluğunun üstüne koyarak `distance_score`'u
  ve `NEARBY` açıklamasını satın alabilir. Bölge sayısı veritabanı trigger'ıyla **5**
  ile sınırlı — bu, saldırı yüzeyini sınırlar, kapatmaz.

### Ölçülen performans

2.000 sağlayıcı, 50.000 rezervasyon, adresi kapsayan 70 bölge, dönen 50 aday:

| Ölçüm                                            | Değer   |
| ------------------------------------------------ | ------- |
| Aday havuzu sorgusu (warm)                       | ~10 ms  |
| Planlama                                         | ~1.5 ms |
| Sağlayıcı/rezervasyon tablosunda sequential scan | yok     |

İlk çağrı oturum başına ~70-160 ms sürer; bu PostGIS kütüphanesinin **oturum başına
bir kez** yüklenmesidir, sorgu maliyeti değildir (bağlantı havuzu bunu amorti eder).

## 3. Hard constraints

Kural tektir: **ihlal hiçbir skorla telafi edilmez** (ADR-0007 §4). Eleme skorlamadan
önce ve skorlamadan bağımsız çalışır.

| Kod                       | Anlamı                                                  |
| ------------------------- | ------------------------------------------------------- |
| `PROVIDER_NOT_VERIFIED`   | profil `APPROVED` değil veya kimlik doğrulanmamış       |
| `SERVICE_NOT_OFFERED`     | sağlayıcı bu hizmeti beyan etmemiş                      |
| `MISSING_REQUIRED_SKILL`  | zorunlu yetkinlik **doğrulanmış** olarak yok            |
| `NOT_AVAILABLE`           | hizmetin tamamının sığdığı müsait aralık yok            |
| `BOOKING_CONFLICT`        | aktif rezervasyon var ve geriye yeterli boşluk kalmamış |
| `OUTSIDE_SERVICE_AREA`    | hizmet bölgesi adresi kapsamıyor                        |
| `DISTANCE_LIMIT_EXCEEDED` | `MATCHING_MAX_DISTANCE_METERS` aşıldı                   |
| `CAPACITY_EXCEEDED`       | günlük rezervasyon sınırı dolu                          |

Değerlendirme **iki yerde** yapılır ve bu bilinçli bir tekrardır: AI servisinde
(`app/matching/constraints.py`) ve core'da (`src/matching/core-constraints.ts`).
Core'un kontrolü motorun verisiyle değil **kendi SQL sonucuyla** çalışır — motorun
iddiasını motorun verisiyle doğrulamak denetim değil, tekrar olurdu.

**Dürüst sınır:** aday havuzu sorgusu doğrulama, hizmet, bölge, mesafe, müsaitlik ve
kapasiteyi zaten eliyor. Yani üretimde bu kodların çoğu hiç `true` dönmez. Değeri,
core'un SQL'ine karşı bir kontrol olmalarında değil, **motor sınırını** korumalarında:
AI servisi ayrı bir deploy edilebilir bileşendir, başka bir çağıran da olabilir ve
sürümü core'dan bağımsız ilerleyebilir. Canlı kalan tek kısıt yetkinliktir.

Buna ek olarak core, **çözüm seviyesinde** üç şeyi taze veriye karşı kontrol eder ve
bunlar aday bazlı kontrollerle yakalanamaz:

| Kontrol               | Neden aday bazlı kontrol yetmez                                      |
| --------------------- | -------------------------------------------------------------------- |
| Kapasite (taze okuma) | motor çağrısı transaction dışında; sağlayıcı arada iş almış olabilir |
| Kapasite (parti içi)  | her talep aynı anlık görüntüyü görür; kendi aralarında sayamazlar    |
| Çakışma (parti içi)   | EXCLUDE constraint yakalar ama **tüm transaction'ı** düşürerek       |

## 4. Scoring

Altı bileşen, her biri `[0, 1]` ve **ayrı ayrı saklanır** (ADR-0007 §5). Tek bir
toplam skor saklamak, "neden bu sağlayıcı?" sorusunu sonradan yanıtlanamaz kılar ve
ağırlık deneylerini imkânsızlaştırırdı.

| Bileşen              | Ne ölçer                                              | Tasarım notu                                                                     |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `skill_score`        | zorunlu yetkinliklerdeki **derinlik** (seviye)        | varlık hard constraint'te elenir; ayırt edici olan seviyedir                     |
| `availability_score` | talep penceresinin ne kadarında hizmet başlatılabilir | ikili değil oranlı: geniş müsaitlik optimizasyona hareket alanı verir            |
| `quality_score`      | platform kalite skoru, yoksa doygun deneyim vekili    | doygunluk yeni sağlayıcıların kilitlenmesini önler                               |
| `distance_score`     | mesafenin doğrusal azalışı                            | eşik üstü zaten elenmiş; doğrusal olan açıklanabilir                             |
| `rating_score`       | **Bayes düzeltilmiş** puan                            | ham ortalama, tek sahte değerlendirmeyle sıralamayı manipüle etmeye izin verirdi |
| `preference_score`   | karşılanan tercih oranı (soft, kapalı slug kümesi)    | tercih yoksa 1.0 (karşılanmamış istek yok)                                       |

Ağırlıklar **koda gömülmez** (ADR-0012 §2): `app/matching/weights.py` içinde sürümlü
config nesneleridir ve toplamları 1.0 olmak zorundadır.

`weights-v1` (başlangıç, blueprint §13 örneği): skill 0.25, availability 0.20,
quality 0.15, distance 0.15, rating 0.10, preference 0.15.

> Bu ağırlıklar **kanıtlanmış değil, başlangıç değerleridir.** Ayarlanmaları için
> gerçek kabul/tamamlanma verisi gerekir; o veri Faz 15-16'dan önce yoktur.

## 5. Ranking

Sıralama ile optimizasyon **ayrı kavramlardır**:

- Sıralama tek talep için adayları karşılaştırır; başka talepleri bilmez.
- Optimizasyon talepleri birlikte çözer; kapasite ve seyahat nedeniyle bir talebin
  "en iyi" adayı başka bir talebe gidebilir.

Bu yüzden "en yüksek skor kazanır" nihai strateji **değildir**.

**Determinizm (T-17).** Skor 4 haneye yuvarlanır, eşitlik `provider_id` ile çözülür.
Rastlantısal bileşen yoktur; aday havuzunun geliş sırası sonucu etkilemez. Sıralama
katmanı koşulsuz deterministiktir.

Motor ayrıca **talep kümesini de** kanonik sıraya (`request_id`) alır. Gerekçesi bir
karşı örnekle görünür: kapasite yüzünden üç talepten ikisi atanabiliyorsa tüm atama
kümeleri amaç değeri bakımından eşittir ve "hangi müşteri boşta kalır" sorusunun
cevabını listenin sırası verirdi. Core zaten sıralı gönderiyor, ama determinizm
çağıranın nezaketine bırakılamaz.

## 6. Optimization (OR-Tools CP-SAT)

`app/optimization/model.py`. Değişkenler ve kısıtlar:

- her talep **en fazla** bir sağlayıcıya (`Σ x[b][p] ≤ 1`) — atanmamak geçerli bir
  sonuçtur; "her talep atanmalı" deseydi tek uygunsuz talep tüm çözümü INFEASIBLE yapardı,
- başlangıç zamanı, adayın müsait olduğu aralıklardan **birinin** içinde (seçim değişkeni),
- kapasite **sağlayıcı ve gün** bazında (farklı günler aynı kotayı tüketmez),
- aynı sağlayıcının iki hizmeti arasında **yol süresi** kadar boşluk (ardışıklık
  değişkeniyle, her iki yön için ayrı).

Amaç fonksiyonu da sürümlüdür (`app/optimization/objective.py`):

```
maksimize Σ atama·(ATAMA_ÖDÜLÜ + skor·ÖLÇEK − sıra − yol_cezası·ev_yolu_dk)
        − Σ ardışık_çift·yol_cezası·aradaki_yol_dk
```

`objective-v1`: `score_scale=10_000`, `assignment_bonus=1_000_000`,
`travel_penalty_per_minute=5`, `rank_tiebreak=1`. Katsayıların büyüklük sırası
önceliği belirler: bir müşteriyi sağlayıcısız bırakmak, daha iyi skorlu bir
atamadan her zaman kötüdür.

**Determinizm sınırı (dürüst ifade).** Çözücü `num_workers=1` ve `random_seed=0` ile
çalışır; talepler kanonik sırada kurulur ve eşit amaç değerli çözümler arasında
sıralama sırası (`rank_tiebreak`) karar verir. Çözücü tamamlandığında (OPTIMAL /
INFEASIBLE) sonuç deterministiktir.

`FEASIBLE` — CP-SAT dilinde "zaman limiti doldu, bir çözüm var ama en iyi olduğu
**kanıtlanamadı**" — bozulmuş sayılır ve `OPTIMIZATION_TIMEOUT` ile işaretlenir.
Atama geçerlidir; iddia edilmeyen tek şey en iyiliktir. Bunu bozulmamış raporlamak,
"kararların yüzde kaçı zaman limitine takıldı" sorusunu yanıtsız bırakırdı.

## 7. Routing

`app/routing/port.py` — dar bir port: iki nokta arası tahmin ve mesafeden süre tahmini.
Sağlayıcıya "şu atamayı optimize et" dedirtmek, Emek'in optimizasyon mantığını dış
servise taşımak olurdu (CLAUDE.md §2: routing altyapıdır, Ar-Ge motoru değil).

Varsayılan uygulama `HaversineRouter`: kuş uçuşu mesafe × 1.3 sapma katsayısı,
30 km/sa sabit hız. **Gerçek rota değildir** ve raporlarda öyle etiketlenmez.

`FallbackRouter` birincil sağlayıcı düştüğünde kuş uçuşuna döner, bozulmayı işaretler
ve birincili o çalıştırma boyunca **tekrar denemez** (her aday için zaman aşımı
beklemek gecikmeyi aday sayısıyla çarpardı).

## 8. Explainability

Açıklama **saklanan skor bileşenlerinden ve kısıt sonuçlarından** üretilir; modele
"neden seçtin" diye sorulmaz (ADR-0007 §6). Kapalı kod kümesidir — istemci metni kendi
diliyle üretir.

Sızıntı sınırı (T-19):

- Müşteri yanıtı **yalnızca seçilen** sağlayıcıyı içerir. "Şu 9 sağlayıcı da müsaitti"
  demek, o sağlayıcıların takvimini ve konumunu sızdırmaktır.
- Ham skor bileşenleri müşteriye **dönmez**: iç karar verisidir; dışarı verilmesi
  sıralamayı oyunlaştırmaya ve karşılaştırmalı veri sızıntısına kapı açar.
- Mesafe kilometreye ve bir haneye yuvarlanır: metre hassasiyeti, tekrarlanan
  taleplerle sağlayıcının konumunu üçlemeye izin verirdi.

Tam sıralama yalnızca `ADMIN` uçundan (`GET /matching/runs/{requestId}`) görülür.

## 9. Bozulma (degradation)

İki ayrı bozulma yolu vardır ve ikisi de **işaretlidir**:

| Durum                           | Ne olur                                                    | Etiket                    |
| ------------------------------- | ---------------------------------------------------------- | ------------------------- |
| Optimizasyon timeout/infeasible | AI servisi kendi sıralamasından açgözlü atama yapar        | `RANKED_FALLBACK` + neden |
| Rota servisi erişilemez         | kuş uçuşu tahmine dönülür                                  | `ROUTING_UNAVAILABLE`     |
| **AI servisi erişilemez**       | core kendi deterministik (mesafe sıralı) yedeğini kullanır | `ENGINE_UNAVAILABLE`      |

Üçünde de hard constraint kuralı geçerlidir: bozulmuş modda da ihlalli bir sağlayıcı
atanmaz.

Core'un yedek yolu skor bileşenlerini **uydurmaz**: yalnızca mesafe bileşeni
hesaplanır, diğerleri 0 kalır ve toplam skor mesafe bileşenine eşittir. Satırlar
`algorithm_version = 'fallback-distance-v1'` ile saklandığı için Ar-Ge sorgularında
motor kararlarıyla karışmaz.

## 10. Sürümleme

Her karar üç sürüm etiketi taşır ve `matching_runs`'a yazılır:

| Alan                | Örnek          | Ne değişince artar          |
| ------------------- | -------------- | --------------------------- |
| `algorithm_version` | `matching-v1`  | zincirin kendisi            |
| `weights_version`   | `weights-v1`   | skor ağırlıkları            |
| `objective_version` | `objective-v1` | amaç fonksiyonu katsayıları |

Kayıtlı sürümler silinmez: geçmiş kararlar hangi ağırlıkla verildiyse o ağırlıkla
yeniden üretilebilmelidir. Bilinmeyen bir sürüm istenirse **hata verilir**; sessizce
varsayılana düşmek, kararı yanlış sürüme atfetmek olurdu.

`booking_match_results` append-only'dir (trigger): karar değişirse **yeni bir
çalıştırma** yazılır. Sonradan düzeltilebilen bir deney kaydı kanıt değeri taşımaz.

## 11. API

| Uç                                            | Rol                | Döndürdüğü                        |
| --------------------------------------------- | ------------------ | --------------------------------- |
| `POST /booking-requests/{id}/match`           | talebin **sahibi** | seçilen sağlayıcı + açıklama      |
| `GET /booking-requests/{id}/match`            | talebin **sahibi** | son çalıştırmanın seçimi          |
| `POST /matching/runs`                         | `ADMIN`            | toplu (küresel) eşleştirme        |
| `GET /matching/runs/{requestId}`              | `ADMIN`            | tam sıralama + skor bileşenleri   |
| `GET/POST/DELETE /providers/me/services`      | `PROVIDER`         | sunulan hizmetler                 |
| `GET/POST/DELETE /providers/me/service-areas` | `PROVIDER`         | hizmet bölgeleri (merkez+yarıçap) |

Oran sınırları düşüktür (tek talep 10/dk, toplu 5/dk): her çağrı bir aday havuzu
sorgusu ve bir optimizasyon çalıştırması demektir.

**Motor çağrısı transaction dışında yapılır.** Transaction içinde yapılsaydı, 10
saniyeye kadar sürebilen bir çağrı boyunca hem bir havuz bağlantısı hem de talep
satırlarının kilidi tutulurdu: yavaşlayan bir AI servisi, havuzu (varsayılan 10
bağlantı) tüketip **ilgisiz tüm endpoint'leri** durdururdu. Bedeli, aday verisinin
yazma anında bayat olmasıdır — bu yüzden kapasite, durum ve müsaitlik yazma
transaction'ında **yeniden okunur**.

## 12. Yapılandırma

| Değişken                             | Varsayılan | Not                                          |
| ------------------------------------ | ---------- | -------------------------------------------- |
| `MATCHING_SERVICE_TIMEOUT_MS`        | 10000      | NLP'den uzun: optimizasyon kombinatoryaldir  |
| `MATCHING_MAX_DISTANCE_METERS`       | 50000      | AI tarafıyla **aynı** olmalı                 |
| `MATCHING_CANDIDATE_LIMIT`           | 50         | "en yakın N"                                 |
| `MATCHING_BATCH_LIMIT`               | 25         | tek toplu çalıştırmadaki talep sayısı        |
| `AI_MATCHING_MAX_DISTANCE_METERS`    | 50000      | core tarafıyla **aynı** olmalı               |
| `AI_OPTIMIZATION_TIME_LIMIT_SECONDS` | 5.0        | aşılırsa fallback devreye girer              |
| `AI_SERVICE_TIMEZONE_OFFSET`         | +03:00     | core'daki `SERVICE_TIMEZONE_OFFSET` ile aynı |

## 13. Tekrarlayan müsaitlik (RRULE) — neden hâlâ yok

Faz 4 tekrarlama motorunu bilinçli olarak yazmamış ve gerçek ihtiyacın Faz 7'de
netleşmesini beklemişti. **Netleşti: matching recurrence gerektirmiyor.**

Gerekçe: aday havuzu ve optimizasyon **somut zaman aralıklarıyla** çalışır. CP-SAT
modeli başlangıç zamanını mutlak dakikalar üzerinden çözer; müsaitliğin nasıl
üretildiği (elle mi, haftalık şablondan mı) modelin görüş alanında değildir.
Recurrence bir **giriş kolaylığıdır** ve sağlayıcı arayüzüne (Faz 16) aittir:
şablondan somut aralık üretilir, bu tablo değişmez.

Bu yüzden Faz 7'de recurrence eklenmedi ve risk **açıkça korundu** (R-47).
