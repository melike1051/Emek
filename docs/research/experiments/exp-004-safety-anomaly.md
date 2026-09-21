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

- 19 senaryo ailesi × 20 oturum = **380 oturum** (220 normal, 160 olay), tohum `20260922`;
  ayrık kontrol tohumu `1729` (aynı kod, tasarım sırasında bakılmamış ikinci üretim).
- Değerlendirme her 120 sn'de bir: **22 780 değerlendirme anı** (birincil tohum).
- Oturumlar **üretim kodundan** geçer: `processBatch` (doğrulama + geofence + debounce),
  `buildSignals`/`summarizeTrace`, `buildAnomalyFeatures`/`toWire`, `evaluateRules`,
  `aggregateRisk`. Anomali skorları gerçek Python modelinden (`app.evaluation.safety.score`,
  endpoint ile aynı kod yolu) toplu alınır. Tek fark mesafe kaynağıdır (burada haversine,
  üretimde PostGIS).
- Kural seti `safety-rules-v2`, toplama `risk-agg-v2`, model `anomaly-deviation-v1`
  (taban çizgisi) ve `-v2` (varsayılan), bayrak eşiği 0,8, kalite kapısı 0,5.

Normal aileler: zamanında (N01), yavaş trafik (N02, 5-13 dk geç), kapalı alan jitter'ı
(N03, doğruluk 40-90 m, %10 örnek 150-400 m), kısa sinyal kaybı (N04, 4-8 dk), meşru süre
aşımı (N05, 1,2-1,45×), erken varış ve bekleme (N06), kısa çıkış (N07, 2-4,5 dk), cihaz
uykusu ve tampon boşaltma (N08, 6-12 dk), küçük saat sapması (N09, +20-90 sn), trafik
sapması (N10, 400-800 m), **zararsız tekrarlar** (N11: 2-3 kez 5,5-8 dk sinyal kaybı +
2-3 kez 2-4 dk çıkış — asansör/bodrum ölü bölgesi, araca iki kez gitmek).

Olay aileleri (başlangıç anı etiketli): uzun çıkış (I01), telemetri kesintisi (I02),
varışta uzaklaşma (I03), GPS sahteciliği (I04), yolda takılma (I05), **ince bileşim**
(I06: 3 × 7-9 dk sessizlik + 3 × 4 dk çıkış + 1,45× süre — her biri kendi kural
eşiğinin altında), panik (I07), yola çıktıktan sonra hiç telemetri yok (I08). Tüm
örneklerin ~%5'i ağ tekrarı olarak yeniden gönderilir.

Kollar: `rules` (yalnız kurallar), `hybrid_v1`/`hybrid` (kurallar + v1/v2 model,
`risk-agg-v2`), `anomaly_v1`/`anomaly` (yalnız model, ≤ WARNING). Panik kurallar ve hibrit
kollarda deterministiktir; **yalnız-model kolları panikten kredi almaz** (modeli ölçerler).

## 3. Metrikler (deneyden önce tanımlandı)

Oturum düzeyinde, eşik `WARNING` ve `HIGH_RISK` için: olay oturumunda başlangıçtan sonra
eşiğe ulaşılırsa **TP**; normal oturumda herhangi bir anda ulaşılırsa **FP**. Başlangıç
öncesi alarmlar TP/FP'ye girmez, ayrıca sayılır. Precision, recall, FPR, FNR, tespit
gecikmesi (başlangıç → ilk alarm anı; 120 sn çözünürlük). Ayrıca: panik hariç recall,
aile bazında alarm oranı, seviye dağılımı, kural tetiklenme sıklığı, telemetri ret
oranları, geofence durum doğruluğu (örnek anındaki debounce durumuyla) ve fazla geçiş
sayısı, rota sapması (R09) davranışı, anomali skor dağılımı, bayrak eşiği duyarlılığı,
ayrık tohum.

## 4. Sonuçlar

### 4.1 Kollar (birincil tohum)

| Kol          | Precision | Recall @W | FPR @W | Recall @W (panik hariç) | Gecikme p50 / p90 (sn) | Recall @HIGH_RISK (panik hariç) | FPR @HIGH_RISK |
| ------------ | --------- | --------- | ------ | ----------------------- | ---------------------- | ------------------------------- | -------------- |
| `rules`      | 0.947     | 0.888     | 0.036  | 0.871                   | 600 / 1036             | 0.625 (0.571)                   | 0              |
| `hybrid_v1`  | 0.947     | 0.888     | 0.036  | 0.871                   | 600 / 1036             | 0.625 (0.571)                   | 0              |
| `anomaly_v1` | 1.000     | 0.500     | 0      | 0.571                   | 1288 / 2647            | 0 (0)                           | 0              |
| `hybrid`     | 0.920     | 1.000     | 0.064  | 1.000                   | 600 / 3491             | 0.625 (0.571)                   | 0              |
| `anomaly`    | 0.943     | 0.625     | 0.027  | 0.714                   | 1619 / 3552            | 0 (0)                           | 0              |

Gecikme notu: `hybrid` p90'ının (3491 sn) `rules`'tan (1036 sn) yüksek olması hibritin
**yavaş** olduğunu göstermez; `rules` kolunun hiç tespit etmediği I06 oturumlarının (geç
tespitlerle) hesaba katılmasından gelir. Aynı aileleri karşılaştırmak için §4.2'ye bakın.

### 4.2 Aile bazında alarm oranı (@WARNING)

| Aile                                | rules | hybrid_v1 | anomaly_v1    | hybrid   | anomaly       |
| ----------------------------------- | ----- | --------- | ------------- | -------- | ------------- |
| N01-N07, N09, N10 (normal)          | 0     | 0         | 0             | 0        | 0             |
| N08 cihaz uykusu (normal)           | 0.40  | 0.40      | 0             | 0.40     | 0             |
| **N11 zararsız tekrarlar (normal)** | 0     | 0         | 0             | **0.30** | **0.30**      |
| I01 uzun çıkış                      | 1     | 1         | 1             | 1        | 1             |
| I02 telemetri kesintisi             | 1     | 1         | 1             | 1        | 1             |
| I03 uzaklaşma                       | 1     | 1         | 1             | 1        | 1             |
| I04 GPS sahteciliği                 | 1     | 1         | 0             | 1        | 0             |
| I05 yolda takılma                   | 1     | 1         | 1             | 1        | 1             |
| I06 ince bileşim                    | 0.10  | 0.10      | 0             | **1**    | **1**         |
| I07 panik                           | 1     | 1         | 0 (kredi yok) | 1        | 0 (kredi yok) |
| I08 hiç telemetri yok               | 1     | 1         | 0             | 1        | 0             |

Seviye: tüm kollarda I01/I02/I08 20/20 `HIGH_RISK`; I03 9/20, I05 11/20 `HIGH_RISK`,
kalanı `WARNING`. `hybrid`, I06'da 20/20 `WARNING` üretir (hiçbiri `HIGH_RISK` değil).

### 4.3 Ayrık tohum (1729)

| Kol          | Recall @W | FPR @W | Recall @HIGH_RISK | N08 alarm | N11 alarm | I06 alarm |
| ------------ | --------- | ------ | ----------------- | --------- | --------- | --------- |
| `rules`      | 0.881     | 0.014  | 0.644             | 0.15      | 0         | 0.05      |
| `hybrid_v1`  | 0.881     | 0.014  | 0.644             | 0.15      | 0         | 0.05      |
| `anomaly_v1` | 0.488     | 0      | 0                 | 0         | 0         | 0         |
| `hybrid`     | 1.000     | 0.027  | 0.644             | 0.15      | 0.15      | 1         |
| `anomaly`    | 0.613     | 0.014  | 0                 | 0         | 0.15      | 1         |

Yön birincil tohumla aynı; oranlar ±0,15 ölçeğinde oynuyor (aile başına 20 oturum).

### 4.4 Duyarlılık (bayrak eşiği; varsayılan değiştirilmedi)

Aynı toplama politikası, yalnızca eşik farklı (`aggregateRisk({ flagThreshold })`).

| Eşik | `anomaly` (v2) recall / FPR @W | `hybrid` recall / FPR @W | `hybrid` recall @HIGH_RISK |
| ---- | ------------------------------ | ------------------------ | -------------------------- |
| 0.8  | 0.625 / 0.027                  | 1.000 / 0.064            | 0.625                      |
| 0.7  | 0.750 / 0.027                  | 1.000 / 0.064            | 0.625                      |
| 0.6  | 0.750 / 0.091                  | 1.000 / 0.127            | 0.625                      |
| 0.5  | 0.750 / 0.091                  | 1.000 / 0.127            | 0.625                      |

Eşiği düşürmek hibritin recall'unu artırmıyor, yanlış alarmı artırıyor. v1'de eşik
0,5'e kadar inse de I06 hiç yakalanmıyor.

Skor dağılımı: normal oturumlarda v2 p50 = p90 = 0 (15 472 an), bayrak oranı 0,0015;
olay başlangıcından sonra v2 p50 0.64, p90 0.90, bayrak oranı 0.236.

### 4.5 Telemetri ve geofence

- 86 192 gerçek örnekten **1**'i reddedildi (`IMPOSSIBLE_SPEED`; oran < 0,0001); enjekte
  edilen 4 698 örneğin (4 398 ağ tekrarı, 300 ışınlanma) **tamamı** reddedildi.
- Geofence durum doğruluğu (kesin gerçek konumlu 86 113 örnek, örnek anındaki durumla):
  **0.977**. Debounce edilmiş geçiş 606 = gerçek geçiş 606; kapalı alan jitter ailesinde
  oturum başına fazla geçiş **0**.
- Rota sapması (R09): uzaklaşma ailesinde tespit **1.0**, trafik sapması ve yavaş
  trafikte yanlış tetikleme **0**.
- Kural tetiklenme (oturum): normal oturumlarda yalnızca R03 (8 oturum, hepsi N08).

### 4.6 Panik ve gecikme (veritabanına bağlı, [`exp-004-latency.json`](exp-004-latency.json))

Simülasyonda panik yapı gereği anında `EMERGENCY`'dir; üretimde panik değerlendirmeyi
beklemez. Gerçek yol ayrıca ölçüldü — **yerel geliştirme makinesi (Apple M4, Docker
Postgres/Redis), tek istemci, anomali servisi erişilemez; yük testi değildir** (sayılar
JSON dosyasındadır; §2.4.1 özetine bakın).

| Ölçüm (30 örnek)                              | p50     | p95      |
| --------------------------------------------- | ------- | -------- |
| Telemetri paketi (10 örnek, HTTP)             | 7,8 ms  | 10,4 ms  |
| Değerlendirme (AI erişilemez, devre kesicili) | 4,3 ms  | 5,7 ms   |
| Panik, sıralı (HTTP)                          | 11,2 ms | 13,4 ms  |
| Panik, 3 tur × 10 eşzamanlı, havuz 10         | 64,5 ms | 335,7 ms |
| Panik, 3 tur × 10 eşzamanlı, havuz 20         | 56,3 ms | 328,0 ms |

Eşzamanlı panik kuyruğu sıralıdan belirgin biçimde yavaş. Havuz 10 → 20 kuyruk
gecikmesini değiştirmedi: **neden bağlantı havuzu değildir** (önceki ölçümün karıştırıcısı
elendi). **Hipotez (kanıtlanmadı):** her audit'li transaction global hash zinciri kilidini
(ADR-0013) alıyor ve panik iki audit kaydı yazıyor (R-54, R-74). Tek ölçüm, tek makine;
sayılar tekrarda değişir (ör. önceki koşuda sıralı p95 13,8 ms).

## 5. Yorum

- **H1 kabul (sentetik).** Kurallar anlık gözlenebilen olay ailelerinin tamamını
  yakaladı; tek yanlış alarm kaynağı cihaz uykusu (N08, R03). Bu bilinçli bir bedeldir
  (R-55): sunucu, tamponlayan bir telefonla susturulmuş bir telefonu o anda ayırt edemez.
- **H2 kısmen kabul, bedeliyle.**
  - v1 (anlık sinyaller) ince bileşimi (I06) hiçbir eşikte yakalayamadı: sapmalar farklı
    anlarda olduğu için hiçbir değerlendirmede birlikte görünmediler.
  - v2 (oturum geçmişi: tekrarlayan uzun boşluk ve çıkış) I06'yı yakalıyor
    (`hybrid` recall 0.888 → 1.0) **ama** zararsız tekrarlarda da uyarı üretiyor
    (N11: %30; ayrık tohumda %15). Hibrit FPR 0.036 → 0.064. Model sinyali `WARNING`
    ile sınırlı ve geri dönüşsüz işlem üretmez; yine de operatör yükü artar.
  - **Model `HIGH_RISK` recall'una hiçbir şey eklemiyor** (0.625 = 0.625). İlk ölçümde
    görülen artış (0.638 → 0.756) aynı gözlemin iki kez sayılmasıydı; `risk-agg-v2` ile
    düzeltildi (§6).
  - **Döngüsellik:** v2 özellikleri I06'nın başarısızlığı görüldükten sonra, I06'yı
    tanımlayan aynı ekip tarafından tasarlandı; I06'daki 1.0 bağımsız doğrulama değildir
    (R-63). N11 ailesi ise v2'nin maliyetini görünür kılmak için eklendi.
- **H3 kabul.** Jitter ailesinde fazla geçiş 0; geçiş sayısı gerçekle birebir.
- **H4 kabul.** Gerçek örneklerde ret < 0,0001; enjekte edilenlerde 1.0.
- Model tek başına sahteciliği (I04) ve hiç telemetri olmamasını (I08, kalite kapısı)
  görmez ve hiçbir zaman `HIGH_RISK` üretemez: kuralların yerine geçemez.

## 6. Geliştirme ve review sırasında bulunan hatalar (açıklama)

Aşağıdaki "önce" değerleri **mevcut kodla yeniden üretilemez**; ilgili sürümler
yayımlanmadan düzeltildi ve şeffaflık için kaydedilir.

| Bulgu                                                                                            | Etki (düzeltme öncesi ölçüm)                                                             | Düzeltme                                                                                               |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| R02 v1 bayat geofence durumuna dayanıyordu ve süreyi yaklaşmadan sayıyordu                       | normal oturumlarda R02 4 oturum                                                          | R02 v2: taze (≤ 5 dk) kesin kanıt + süre check-in'den                                                  |
| R10 v1 debounce gecikmesini "dışarıda check-in" sanıyordu                                        | normal oturumlarda R10 6 oturum; `rules` FPR 0.065                                       | R10 v2: check-in + 5 dk sonra hâlâ gelinmedi + taze dışarıda kanıt                                     |
| R07 hareketi 60 dk'lık iz penceresinden ölçüyordu                                                | R07 **hiç** tetiklenmedi (I05 dâhil)                                                     | hareket/eğilim son 30 dk'dan                                                                           |
| Hizmet sırasında "hareketsizlik" kuralı ve model özelliği (tasarım)                              | GPS daire içi hareketi göremez → her uzun işte alarm                                     | kaldırıldı; R07 "yolda takılma" (R-62)                                                                 |
| **`risk-agg-v1`: aynı sinyalden gelen model skoru, o sinyalin kuralını "doğruluyordu"** (review) | `HIGH_RISK` recall 0.638 → 0.756 görünüyordu; R02/R03 `HIGH_RISK` eşikleri fiilen ~18 dk | `risk-agg-v2`: yalnızca uyarı veren ailelerin katkıları çıkarıldıktan sonra kalan skor ikinci kanıttır |
| Yalnız-model kolları panik oturumlarından kredi alıyordu (review)                                | `anomaly` `HIGH_RISK` recall 0.125'in tamamı panikti                                     | yalnız-model kolları paniği saymaz; panik hariç metrikler eklendi                                      |
| v2'nin FPR = 0'ı üreteç gereğiydi: hiçbir normal ailede zararsız tekrar yoktu (review)           | "FPR değişmedi" iddiası                                                                  | N11 ailesi + ayrık tohum eklendi; v2'nin bedeli raporlandı                                             |
| v2, varışta `repeated_exits`'i 0 olarak "ölçüyor", kaliteyi şişiriyordu (review)                 | varış aşamasında kalite kapısı biraz daha kolay geçiliyordu                              | varışta özellik hiç yok                                                                                |
| Geofence doğruluğu paket sonundaki durumla karşılaştırılıyordu (review)                          | 0.980 (hafif yanlı)                                                                      | örnek anındaki durum → 0.977                                                                           |
| Üreteç: I06 bozuk fix içeriyordu; varış sapması dönüşte eski noktaya sıçrıyordu                  | I06 kurallarla "yakalanıyordu"; 22 gerçek örnek reddediliyordu                           | düzeltildi                                                                                             |

## 7. Tehditler (geçerlilik)

- **Döngüsellik:** üreteç, kurallar ve model aynı varsayımlardan geliyor (R-63). Ayrık
  tohum aynı üreteçten gelir; bağımsız veri değildir.
- **Normal oturumlar hâlâ temiz:** gerçek GPS'te çok yollu yansıma, kentsel kanyon,
  cihaz farkları ve kullanıcı davranışı çeşitliliği yok.
- **Küçük örneklem:** aile başına 20 oturum; iki tohum arasında aile oranları ±0,15 oynuyor.
- **Zaman çözünürlüğü:** gecikme 120 sn değerlendirme aralığıyla nicemlidir.
- **Mesafe:** haversine; PostGIS sferoid mesafesiyle fark karar eşiklerinin çok altında.
- **Gecikme ölçümü:** tek makine, tek istemci; üretim kapasitesi hakkında bilgi vermez (R-64).

## 8. Karar

- `safety-rules-v2` ve `risk-agg-v2` kabul edildi.
- `anomaly-deviation-v2` varsayılan kaldı; v1 karşılaştırma için kayıtlı. Gerekçe: model
  yalnızca `WARNING` üretir (geri dönüşsüz işlem yok) ve kuralların hiç göremediği bir
  olay sınıfını (I06) yakalıyor. **Bedeli açık:** zararsız tekrarlarda yanlış uyarı
  (R-71). Gerçek veride N11 benzeri örüntüler yaygınsa v2'nin tekrar eşikleri
  kalibre edilmeli ya da v1'e dönülmeli.
- Bayrak eşiği **0,8'de bırakıldı**: düşürmek recall'u artırmadan FPR'yi artırıyor.
- Sonraki adım: gerçek (anonimleştirilmiş) oturum verisiyle bağımsız değerlendirme
  (Faz 16-17); eşzamanlı panik gecikmesinin nedeninin ölçülmesi (R-54, Faz 14).
