# ADR-0018 — Faz 7 Karar Zinciri: Aday Havuzu Core'da, Optimizasyon AI'da, Doğrulama İki Kez

- Durum: Accepted (2026-09-21)
- Faz: 7
- Blueprint: §13, §24, §34
- İlgili: [ADR-0002](0002-language-boundaries.md), [ADR-0007](0007-llm-does-not-decide.md),
  [ADR-0012](0012-research-versioning.md)

## Bağlam

ADR-0007 "LLM seçmez, deterministik motor seçer" demişti ama zincirin **hangi
halkasının hangi serviste** çalışacağını, kısıtların nerede zorlanacağını ve motor
erişilemezken ne olacağını uygulamaya bırakmıştı. Faz 7 bu soruları yanıtlamak
zorunda: yanıtsız bırakılırsa her halka iki yere birden yazılır veya hiçbirine.

Ayrıca Faz 2-4 şeması eşleştirme için iki şeyi hiç modellememişti: sağlayıcının
**hangi hizmeti sunduğu** ve **günlük kapasitesi**. İkisi olmadan aday havuzu
istenen hizmete göre daraltılamaz ve kapasite kısıtı anlamsız kalır.

## Karar

### 1. Aday havuzu core'da, SQL/PostGIS ile üretilir

AI servisi veritabanına **hiç bağlanmaz** — ADR-0002 ona salt-okunur erişim
öngörmüştü, Faz 7 bundan daha katı davranıyor: adaylar core tarafından getirilir ve
**özellik vektörü** olarak HTTP ile taşınır.

Gerekçe: iki servisin aynı şemaya bağlanması, şema değişiminde iki tarafı birden
kırar ve AI servisine veritabanı kimlik bilgisi vermeyi gerektirir. Özellik vektörü
sınırı ayrıca bir **güvenlik sınırıdır**: AI servisi hangi sağlayıcıların var
olduğunu değil, yalnızca bu talep için değerlendirilmesi gerekenleri görür.

Bedeli: aday sayısı arttıkça istek gövdesi büyür. `MATCHING_CANDIDATE_LIMIT` ile
sınırlanır (varsayılan 50).

### 2. Scoring, ranking ve optimization AI servisinde

ADR-0002'deki dil sınırı korunur. Sıralama da AI tarafındadır: optimizasyon
sıralamanın çıktısını girdi olarak alır ve ikisini farklı servislere bölmek,
her çalıştırmada bir ağ turu daha eklerdi.

### 3. Hard constraint'ler **iki kez** değerlendirilir

AI servisinde (skorlamadan önce) ve core'da (atamayı kabul etmeden önce). Bu
bilinçli bir tekrardır, kopya değil:

- Core'un kontrolü **kendi SQL sonucuyla** çalışır, motorun yanıtıyla değil.
  Motorun iddiasını motorun verisiyle doğrulamak denetim değil, tekrar olurdu.
- Tek katmanlı olsaydı "hard constraint ihlali hiçbir skorla telafi edilemez"
  kuralı, motorun doğru çalıştığı varsayımına bağlı kalırdı. Motor sürüm
  değiştirdiğinde, yanlış yapılandırıldığında veya yanıtı bozulduğunda ihlalli
  bir sağlayıcı rezervasyona dönüşürdü.

Doğrulamadan geçmeyen atama **düşer**, sayaç artar (`matching_runs.constraint_violations`)
ve talep atanmamış sayılır.

### 4. Üç kademeli bozulma, hepsi işaretli

| Kademe | Tetikleyici               | Davranış                                   | Etiket                |
| ------ | ------------------------- | ------------------------------------------ | --------------------- |
| 1      | rota servisi erişilemez   | kuş uçuşu tahmin                           | `ROUTING_UNAVAILABLE` |
| 2      | optimizasyon timeout/hata | AI'nın sıralamasından açgözlü atama        | `RANKED_FALLBACK`     |
| 3      | AI servisi erişilemez     | core'un mesafe sıralı deterministik yedeği | `ENGINE_UNAVAILABLE`  |

Etiketsiz bir fallback bozulmayı ölçülemez kılar: üretimde "ne sıklıkla bozulmuş
modda karar veriyoruz" sorusu yanıtsız kalırdı. Üç kademede de hard constraint
kuralı geçerlidir.

Core'un yedeği skor bileşenlerini **uydurmaz**: yalnızca mesafe hesaplanır, diğer
bileşenler 0 kalır ve satırlar ayrı bir `algorithm_version` ile saklanır.

### 5. `provider_services`: sunulan hizmet, yetkinlikten ayrı modellenir

Yetkinlik "ne yapabiliyor", hizmet "neyi satıyor" sorusunun cevabıdır. "Yetkinliği
var, demek ki sunuyordur" varsayımı sağlayıcıyı satmak istemediği bir işe atardı.
Aday havuzu **hizmetten** başlar; yetkinlik hard constraint olarak sonra devreye girer.

### 6. Kapasite `provider_profiles.max_daily_bookings` ile, gün **yerel** gündür

Varsayılan 2, aralık 1-10. `NULL` (sınırsız) seçilmedi: sınırsız kapasite,
optimizasyonun aynı sağlayıcıya sınırsız iş yığmasına izin verirdi ve kombinatoryal
patlamaya kapı açardı (R-16).

Gün, müşterinin yaşadığı zaman dilimindeki gündür (`SERVICE_TIMEZONE_OFFSET`). UTC
günü kullanmak, yerel gece yarısı ile UTC gece yarısı arasındaki üç saatte kapasiteyi
yanlış güne yazardı.

### 7. Hizmet bölgesi girdisi **merkez + yarıçap**, serbest poligon değil

Kendini kesen veya ters yönlü bir poligon GIST sorgusunu sessizce yanlış sonuç
verdirir ve `ST_IsValid` CHECK'i isteği çalışma zamanında düşürür. Daire,
istemciden gelebilecek en basit ve her zaman geçerli geometridir; birbirine değmeyen
bölgeler birden fazla kayıtla ifade edilir. Serbest poligon içe aktarımı bir
operasyon aracıdır ve Faz 10'a aittir.

### 8. Üç fazlı akış: oku → karar ver → yaz

İlk tasarım tek bir transaction kullanıyordu ve motor çağrısını **içine** alıyordu.
Bu yanlıştı: 10 saniyeye kadar sürebilen bir HTTP çağrısı boyunca hem bir havuz
bağlantısı (varsayılan havuz 10) hem de talep satırlarının kilidi tutuluyordu.
Yavaşlayan bir AI servisi, havuzu tüketip **ilgisiz tüm endpoint'leri** durdururdu.

Akış üç faza ayrıldı:

1. **Oku** (kısa transaction): talepleri sıralı kilitle, doğrula, aday havuzunu getir.
2. **Karar ver** (transaction yok): motoru çağır. Bekleme, bağlantı tutmadan yapılır.
3. **Yaz** (transaction): talebi yeniden kilitle, durumu yeniden oku, kapasiteyi
   **taze** oku, rezervasyonu ve karar kaydını yaz.

Bedeli, 2. fazdan sonra aday verisinin bayat olmasıdır. Bunu telafi eden şey, 3.
fazın zaten var olan doğrulama katmanını **taze veriyle** çalıştırmasıdır: durum
(eşzamanlı ikinci eşleştirme), kapasite (`FOR SHARE` ile kilitli yeniden okuma) ve
müsaitlik (`createWithin` içindeki kilitli kontrol + EXCLUDE constraint).

Rezervasyon ve karar kaydı 3. fazda **aynı** transaction'da yazılır
(`BookingsService.createWithin(client, …)`): ayrı transaction açmak "karar yazıldı
ama rezervasyon oluşmadı" durumunu mümkün kılardı.

Durum makinesi atlanmaz: eşleştirme de `SYSTEM` aktörüyle aynı geçiş tablosundan
geçer (`REQUESTED → MATCHED → PROVIDER_PENDING`). Ayrı bir "içeriden güncelleme"
yolu açmak transition map'i atlatılabilir kılardı (ADR-0006).

### 9. Toplu eşleştirme asıl yoldur, tek talep onun özel hâlidir

Kapasite ve seyahat kısıtları nedeniyle bir talebin en iyi sağlayıcısı başka bir
talebe gidebilir; "her talebe en yüksek skorluyu ver" tek talebi doğru, talep
kümesini yanlış çözer. Tek talep de aynı kod yolundan geçer — ayrı bir yol açmak,
iki yolun zamanla ayrışması demek olurdu.

Bunun bir sonucu, doğrulamanın **parti boyunca birikmek zorunda** olmasıdır. Her
talebi bağımsız doğrulamak yetmez: hepsi aynı anlık görüntüden gelen aynı
`dailyBookingCount` değerini görür ve hiçbiri diğerinin atamasını bilmez. Aynı
sağlayıcıya günlük sınırının üstünde iş vermek hiçbir kontrole takılmazdı — EXCLUDE
constraint yalnızca **çakışan** saatleri yakalar, farklı saatlerdeki fazla iş ondan
geçer. Kapasite ve takvim bu yüzden parti durumunda biriktirilir.

### 10. Amaç fonksiyonu da sürümlü config'tir

ADR-0012 §2 ağırlıklar için bunu zaten söylüyordu; Faz 7 aynı kuralı amaç
fonksiyonu katsayılarına uyguladı (`objective-v1`). Katsayı değişimi yeni sürüm
üretir ve `matching_runs.objective_version`'a yazılır.

## Sonuçlar

- AI servisine veritabanı erişimi **hiç** verilmez; şema değişimi tek tarafı etkiler.
- Aday havuzu istek gövdesinde taşınır: 50 aday × ~15 alan mertebesinde bir yük.
- Kısıt mantığı iki dilde yaşar ve **birlikte güncellenmek zorundadır**. Bu bir
  teknik borçtur ve kabul edilmiştir (R-48): alternatifi, doğrulamasız bir karar
  zinciriydi.
- Aday havuzu sorgusu kısıtların çoğunu zaten elediği için core'daki ikinci katman
  üretimde nadiren `true` döner. Değeri core'un SQL'ini denetlemek değil, **motor
  sınırını** korumaktır; canlı kalan tek kısıt yetkinliktir.
- Mesafe, doğrulanmamış bir sağlayıcı beyanına dayanır (R-51). Bölge sayısı 5 ile
  sınırlandı; bu yüzeyi daraltır, kapatmaz.
- `booking_match_results` her talep için birden fazla satır üretir; retention
  politikası Faz 11'e aittir (ADR-0012 zaten bunu öngörüyordu).

## Alternatifler

- **AI servisine salt-okunur DB erişimi (reddedildi):** şema bağımlılığı iki tarafa
  yayılır, kimlik bilgisi dağıtılır, "AI yalnızca kendi görmesi gerekeni görür"
  sınırı kaybolurdu.
- **Kısıtları yalnızca AI'da zorlamak (reddedildi):** ihlalli atamaya karşı tek
  savunma motorun doğruluğu olurdu.
- **Scoring'i core'a taşımak (reddedildi):** ADR-0002 dil sınırını bozar; ayrıca
  optimizasyonla scoring arasında her çalıştırmada bir ağ turu daha eklerdi.
- **Motor erişilemezken hata döndürmek (reddedildi):** ADR-0002 "graceful degrade"
  gereğini karşılamaz; tek bir servis arızası tüm talep akışını durdururdu.

### 11. Mesafe sınırı istekle birlikte taşınır

`MATCHING_MAX_DISTANCE_METERS` her iki serviste ayrı yapılandırılıp "aynı değeri
taşımalıdır" notuyla bırakılsaydı, sapma **sessiz** olurdu: eleme core'un değerine,
`distance_score` motorun değerine göre hesaplanır ve saklanan her skor bileşeni fark
ettirmeden bozulurdu — üstelik hiçbir test kırılmadan. Değer isteğin parçası olunca
sapma imkânsız hâle gelir; motorun kendi ayarı yalnızca varsayılandır.

Aynı sınıf drift'in ikinci örneği katalog slug'larıdır: motorun kapalı `Literal`
kümesi ile core'un seed'i ayrışırsa, o hizmeti isteyen her talep 4xx alır. Buna karşı
`packages/api-contracts/matching/catalog-slugs.json` iki taraflı bir sözleşme olarak
tutulur ve her iki test paketi ona karşı doğrulama yapar.
