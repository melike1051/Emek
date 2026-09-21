# EXP-004 — Güvenlik: kurallar, anomali modeli ve hibrit karar

- Tarih: 2026-09-22
- Faz: 8
- Ar-Ge ekseni: Safety ([research-metrics](../research-metrics.md) §2.4)
- Ham sonuç: [`exp-004-safety-anomaly.json`](exp-004-safety-anomaly.json),
  [`exp-004-latency.json`](exp-004-latency.json)
- Yeniden üretim:
  `npm run exp:safety --workspace=@emek/api` (deterministik; iki koşu bayt bayt aynı) ve
  `npm run exp:safety:latency --workspace=@emek/api` (yerel altyapı gerekir; makineye bağlıdır)

> **Bu deneyin verisi tamamen sentetiktir.** Senaryo üreteci, kuralları ve modeli yazan
> aynı ekip tarafından aynı fazda yazıldı. Sonuçlar gerçek dünya başarımını **değil**,
> sistemin kendi varsayımları altındaki iç tutarlılığını ve gürültüye (GPS jitter, kapalı
> alan, sinyal kaybı, saat sapması, gecikmeli teslim, replay) dayanıklılığını ölçer.
> Hiçbir sayı üretim sonucu olarak sunulamaz (R-63).

## 1. Hipotez

H1. Deterministik kurallar, anlık olarak gözlenebilen olayları (uzun çıkış, telemetri
kesintisi, uzaklaşma, sahte konum, yolda takılma) düşük yanlış alarmla yakalar.
H2. Anomali modeli, **her biri kural eşiğinin altında kalan** sapmaların birleşimini
yakalar ve hibrit karar, kuralların yanlış alarm oranını artırmadan recall'u yükseltir.
H3. Geofence debounce'u kapalı alan jitter'ında sahte giriş/çıkış üretmez.
H4. Telemetri doğrulayıcı gerçek örnekleri reddetmez, enjekte edilen sahte/tekrar
örnekleri reddeder.

## 2. Kurulum

- 18 senaryo ailesi × 20 oturum = **360 oturum** (200 normal, 160 olay), tohum `20260922`.
- Değerlendirme her 120 sn'de bir: **21 366 değerlendirme anı**.
- Oturumlar **üretim kodundan** geçer: `processBatch` (doğrulama + geofence + debounce),
  `buildSignals`/`summarizeTrace`, `buildAnomalyFeatures`/`toWire`, `evaluateRules`,
  `aggregateRisk`. Anomali skorları gerçek Python modelinden (`app.evaluation.safety.score`,
  endpoint ile aynı kod yolu) toplu alınır. Tek fark mesafe kaynağıdır (burada haversine,
  üretimde PostGIS).
- Kural seti `safety-rules-v2`, toplama `risk-agg-v1`, model `anomaly-deviation-v1`
  (taban çizgisi) ve `-v2` (varsayılan), bayrak eşiği 0,8, kalite kapısı 0,5.

Normal aileler: zamanında (N01), yavaş trafik (N02, 5-13 dk geç), kapalı alan jitter'ı
(N03, doğruluk 40-90 m, %10 örnek 150-400 m), kısa sinyal kaybı (N04, 4-8 dk), meşru süre
aşımı (N05, 1,2-1,45×), erken varış ve bekleme (N06), kısa çıkış (N07, 2-4,5 dk), cihaz
uykusu ve tampon boşaltma (N08, 6-12 dk), küçük saat sapması (N09, +20-90 sn), trafik
sapması (N10, 400-800 m).

Olay aileleri (başlangıç anı etiketli): uzun çıkış (I01), telemetri kesintisi (I02),
varışta uzaklaşma (I03), GPS sahteciliği (I04), yolda takılma (I05), **ince bileşim**
(I06: 7-9 dk sessizlikler + 4 dk çıkışlar + 1,45× süre — her biri kendi kural eşiğinin
altında), panik (I07), yola çıktıktan sonra hiç telemetri yok (I08). Tüm örneklerin ~%5'i
ağ tekrarı olarak yeniden gönderilir.

Kollar: `rules` (yalnız kurallar), `hybrid_v1`/`hybrid` (kurallar + v1/v2 model),
`anomaly_v1`/`anomaly` (yalnız model, ≤ WARNING). Panik her kolda deterministiktir.

## 3. Metrikler (deneyden önce tanımlandı)

Oturum düzeyinde, eşik `WARNING` ve `HIGH_RISK` için: olay oturumunda başlangıçtan sonra
eşiğe ulaşılırsa **TP**; normal oturumda herhangi bir anda ulaşılırsa **FP**. Precision,
recall, FPR, FNR, tespit gecikmesi (başlangıç → ilk alarm anı; 120 sn çözünürlük). Ayrıca:
aile bazında alarm oranı, seviye doğruluğu, kural tetiklenme sıklığı, telemetri ret
oranları, geofence durum doğruluğu ve fazla geçiş sayısı, rota sapması (R09) davranışı,
anomali skor dağılımı, bayrak eşiği duyarlılığı.

## 4. Sonuçlar

### 4.1 Kollar (eşik `WARNING`)

| Kol          | Precision | Recall | FPR  | FNR   | Gecikme p50 / p90 (sn) | `HIGH_RISK` recall | `HIGH_RISK` FPR |
| ------------ | --------- | ------ | ---- | ----- | ---------------------- | ------------------ | --------------- |
| `rules`      | 0.946     | 0.881  | 0.04 | 0.119 | 600 / 1025             | 0.638              | 0               |
| `hybrid_v1`  | 0.946     | 0.881  | 0.04 | 0.119 | 600 / 1025             | 0.750              | 0               |
| `anomaly_v1` | 1.000     | 0.625  | 0    | 0.375 | 1260 / 2533            | 0.125              | 0               |
| `hybrid`     | 0.952     | 1.000  | 0.04 | 0     | 600 / 3514             | 0.756              | 0               |
| `anomaly`    | 1.000     | 0.750  | 0    | 0.250 | 1296 / 3553            | 0.125              | 0               |

### 4.2 Aile bazında alarm oranı

| Aile                       | rules | hybrid_v1 | anomaly_v1 | hybrid | anomaly |
| -------------------------- | ----- | --------- | ---------- | ------ | ------- |
| N01-N07, N09, N10 (normal) | 0     | 0         | 0          | 0      | 0       |
| N08 cihaz uykusu (normal)  | 0.40  | 0.40      | 0          | 0.40   | 0       |
| I01 uzun çıkış             | 1     | 1         | 1          | 1      | 1       |
| I02 telemetri kesintisi    | 1     | 1         | 1          | 1      | 1       |
| I03 uzaklaşma              | 1     | 1         | 1          | 1      | 1       |
| I04 GPS sahteciliği        | 1     | 1         | 0          | 1      | 0       |
| I05 yolda takılma          | 1     | 1         | 1          | 1      | 1       |
| I06 ince bileşim           | 0.05  | 0.05      | 0          | **1**  | **1**   |
| I07 panik                  | 1     | 1         | 1          | 1      | 1       |
| I08 hiç telemetri yok      | 1     | 1         | 0          | 1      | 0       |

Seviye: `rules` kolunda I01/I02/I08 20/20 `HIGH_RISK`; I03 10/20 ve I05 12/20 `HIGH_RISK`
(geri kalanı `WARNING`). `hybrid` kolunda I03 ve I05 20/20 `HIGH_RISK` — model, tek kural
ailesinin uyarısını doğrulayan ikinci kanıt oldu. I06'da `hybrid` 19/20 `WARNING`, 1/20
`HIGH_RISK`; tespit gecikmesi p50 **3584 sn** (tekrarların birikmesi gerekiyor).

### 4.3 Duyarlılık (bayrak eşiği; varsayılan değiştirilmedi)

| Eşik | `anomaly_v1` recall / FPR | `anomaly` (v2) recall / FPR | `hybrid` recall / FPR | I06 (`hybrid`) |
| ---- | ------------------------- | --------------------------- | --------------------- | -------------- |
| 0.8  | 0.625 / 0                 | 0.750 / 0                   | 1.000 / 0.04          | 1.00           |
| 0.7  | 0.750 / 0                 | 0.875 / 0                   | 1.000 / 0.04          | 1.00           |
| 0.6  | 0.750 / 0                 | 0.875 / 0                   | 1.000 / 0.04          | 1.00           |
| 0.5  | 0.750 / 0                 | 0.875 / 0                   | 1.000 / 0.04          | 1.00           |

Normal oturumlarda model skoru p50 = p90 = 0 (14 154 an); olay başlangıcından sonra v2 p50
0.64, p90 0.90. Normal ailelerde modelin FPR'si hiçbir eşikte 0'dan büyük değil — bu,
sentetik normal oturumların **fazla temiz** olduğunun işaretidir ve iyimser okunmalıdır.

### 4.4 Telemetri ve geofence

- 81 246 gerçek örnekten **1**'i reddedildi (`IMPOSSIBLE_SPEED`; oran < 0,0001); enjekte
  edilen 4 462 örneğin (4 162 ağ tekrarı, 300 ışınlanma) **tamamı** reddedildi.
- Geofence durum doğruluğu (kesin gerçek konumlu 81 186 örnek): **0.980**. Debounce edilmiş
  geçiş sayısı 480 = gerçek geçiş sayısı 480; kapalı alan jitter ailesinde oturum başına
  fazla geçiş **0** (ortalama ve azami).
- Rota sapması (R09): uzaklaşma ailesinde tespit **1.0**, trafik sapmasında (400-800 m) ve
  yavaş trafikte yanlış tetikleme **0**.
- Kural tetiklenme (oturum): normal oturumlarda yalnızca R03 (8 oturum, hepsi N08);
  R02, R07, R10 normal oturumlarda **0**.

### 4.5 Panik ve gecikme (veritabanına bağlı, [`exp-004-latency.json`](exp-004-latency.json))

Simülasyonda panik yapı gereği anında `EMERGENCY`'dir (tabloda 91 sn görünen değer
değerlendirme anı çözünürlüğüdür, üretimde panik değerlendirmeyi beklemez). Gerçek yol
ayrıca ölçüldü — **yerel geliştirme makinesi (Apple M4, Docker Postgres/Redis), tek
istemci, anomali servisi erişilemez; yük testi değildir**:

| Ölçüm                                     | Örnek | p50 (ms) | p95 (ms) | Maks (ms) |
| ----------------------------------------- | ----- | -------- | -------- | --------- |
| Telemetri paketi (10 örnek), HTTP         | 30    | 8.8      | 12.2     | 120.2     |
| Değerlendirme (servis çağrısı, AI down)   | 30    | 4.7      | 7.4      | 42.7      |
| Panik, sıralı, HTTP                       | 30    | 11.0     | 13.8     | 25.8      |
| Panik, 10 farklı oturumda eşzamanlı, HTTP | 10    | 267.0    | 369.6    | 381.9     |

Eşzamanlı panik gecikmesi sıralıdan ~25 kat yüksek. **Hipotez (kanıtlanmadı):** her
audit'li transaction global hash zinciri kilidini (`pg_advisory_xact_lock`, ADR-0013) alıyor
ve panik iki audit kaydı yazıyor; paralel panikler bu kilitte sıraya giriyor (R-54).

## 5. Yorum

- **H1 kısmen kabul.** Kurallar, anlık gözlenebilen olay ailelerinin tamamını yakaladı;
  tek yanlış alarm kaynağı cihaz uykusu (N08, R03). Bu **bilinçli bir bedeldir**: sunucu,
  tamponlayan bir telefonla susturulmuş bir telefonu o anda ayırt edemez (R-55); 10+ dk
  sessizlikte uyarı vermek tasarım hedefidir.
- **H2 v1 için reddedildi, v2 için sentetik veride kabul.** v1 (anlık sinyaller) ince
  bileşimi (I06) hiçbir eşikte yakalayamadı: sapmalar farklı anlarda olduğu için hiçbir
  değerlendirmede birlikte görünmediler. v2'ye iki oturum geçmişi özelliği (son saatte
  tekrarlayan uzun boşluk ve tekrarlayan çıkış) eklendi; `hybrid` recall 0.881 → 1.0,
  FPR değişmedi (0.04). **Dürüstlük notu:** v2'nin özellikleri I06'nın başarısızlığı
  görüldükten sonra ve I06'yı tanımlayan aynı ekip tarafından tasarlandı; bu sonuç
  döngüseldir ve bağımsız bir veriyle doğrulanmadan genellenemez (R-63).
- **H3 kabul.** Jitter ailesinde fazla geçiş 0, geçiş sayısı gerçekle birebir.
- **H4 kabul.** Gerçek örneklerde ret < 0,0001; enjekte edilenlerde 1.0.
- Model tek başına (`anomaly`) hiçbir zaman `HIGH_RISK` üretemez (tasarım) ve sahteciliği
  (I04) ya da hiç telemetri olmamasını (I08, kalite kapısı) görmez: kuralların yerine
  geçemez, yanında çalışır.

## 6. Geliştirme sırasında bulunan ve düzeltilen hatalar (açıklama)

Aşağıdaki değerler **mevcut kodla yeniden üretilemez**, çünkü ilgili kod sürümleri
yayımlanmadan düzeltildi; şeffaflık için kaydedilir.

| Bulgu                                                                                                                                        | Etki (düzeltme öncesi ölçüm)                              | Düzeltme                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| R02 v1 bayat geofence durumuna dayanıyordu (kapalı alanda kesin gözlem kesilince durum "dışarıda" kalıyordu) ve süreyi yaklaşmadan sayıyordu | normal oturumlarda R02 4 oturum                           | R02 v2: taze (≤ 5 dk) kesin kanıt + süre check-in'den              |
| R10 v1 debounce gecikmesini (≈ 3 örnek) "dışarıda check-in" sanıyordu                                                                        | normal oturumlarda R10 6 oturum; toplam `rules` FPR 0.065 | R10 v2: check-in + 5 dk sonra hâlâ gelinmedi + taze dışarıda kanıt |
| R07 hareketi 60 dk'lık iz penceresinden ölçüyordu; takılmadan önceki sürüş hareketi şişiriyordu                                              | R07 **hiç** tetiklenmedi (I05 dâhil)                      | hareket/eğilim son 30 dk'dan                                       |
| Hizmet sırasında "hareketsizlik" kuralı ve model özelliği (tasarım aşamasında)                                                               | GPS daire içi hareketi göremez → her uzun işte alarm      | kaldırıldı; R07 "yolda takılma" olarak yeniden tanımlandı (R-62)   |
| Üreteç hatası: I06 bozuk fix içeriyordu (R05'i tetikleyip ailenin amacını bozuyordu)                                                         | I06 kurallarla "yakalanıyor" görünüyordu                  | çıkarıldı; I06 artık tanımına uygun                                |
| Üreteç hatası: varış yolundaki sapma dönüşte eski bir noktaya sıçrıyordu                                                                     | 22 gerçek örnek `IMPOSSIBLE_SPEED` ile reddedildi         | dönüş yolun o anki noktasına                                       |

## 7. Tehditler (geçerlilik)

- **Döngüsellik:** üreteç, kurallar ve model aynı varsayımlardan geliyor (R-63).
- **Normal oturumlar fazla temiz:** gerçek GPS verisinde çok yollu yansıma, kentsel kanyon,
  cihazlar arası farklılık ve kullanıcı davranışı çeşitliliği yok; model FPR'si 0 iyimser.
- **Küçük örneklem:** aile başına 20 oturum; oranlar ±0,05 ölçeğinde gürültülü.
- **Zaman çözünürlüğü:** gecikme 120 sn değerlendirme aralığıyla nicemlidir.
- **Mesafe:** haversine; PostGIS sferoid mesafesiyle fark karar eşiklerinin çok altında.
- **Gecikme ölçümü:** tek makine, tek istemci; üretim kapasitesi hakkında bilgi vermez (R-64).

## 8. Karar

- `safety-rules-v2`, `risk-agg-v1` ve `anomaly-deviation-v2` varsayılan olarak kabul edildi.
  v1 model karşılaştırma için kayıtlı kalır.
- Bayrak eşiği **0,8'de bırakıldı**: 0,6-0,7 sentetik veride model-yalnız recall'u
  artırıyor ama hibrit kolu değiştirmiyor ve FPR'nin 0 çıkması normal verinin temizliğinden
  kaynaklanıyor olabilir. Eşik gerçek veriyle kalibre edilecek (R-57, R-61).
- Sonraki adım: gerçek (anonimleştirilmiş) oturum verisiyle bağımsız değerlendirme (Faz 16-17),
  eşzamanlı panik gecikmesinin nedeninin ölçülmesi (R-54, Faz 14).
