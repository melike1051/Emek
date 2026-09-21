# EXP-002 — Matching: basit filtre + mesafe sıralaması vs. kısıt + scoring + CP-SAT

- Tarih: 2026-09-21
- Faz: 7
- Ar-Ge ekseni: Matching + Optimization ([research-metrics](../research-metrics.md) §2.2, §2.3)
- Ham sonuç: [`exp-002-matching-baseline-vs-optimized.json`](exp-002-matching-baseline-vs-optimized.json)
- Yeniden üretim: `cd services/ai && uv run python -m app.evaluation.matching.run`

## 1. Ar-Ge sorusu

> Çok kriterli kısıtlar altında (doğrulama, yetkinlik, müsaitlik, kapasite, coğrafya,
> çakışma) doğru aday havuzu ve sıralaması üretilebilir mi; atama, kapasite ve
> seyahat hedefleriyle **birlikte** optimize edilebilir mi?

## 2. Kollar

| Kol        | `algorithm_version`    | `weights_version`     | `objective_version`         | Ne yapar                                                                                         |
| ---------- | ---------------------- | --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| baseline   | `matching-baseline-v0` | `weights-distance-v0` | `greedy-first-available-v0` | doğrulama + hizmet + "müsaitlik kesişiyor mu" filtresi, mesafe sıralaması, first-available atama |
| proposed   | `matching-v1`          | `weights-v1`          | `objective-v1`              | tam hard constraint seti, 6 bileşenli scoring, deterministik sıralama, CP-SAT küresel atama      |
| duyarlılık | `matching-v1`          | `weights-v1`          | `objective-v2-travel`       | proposed ile aynı, yalnızca yol cezası 12× ağır                                                  |

Baseline **dondurulmuştur ve iyileştirilmez** (ADR-0012 §3, NLP'deki `baseline-v0`
ile aynı disiplin). Yapay olarak sakatlanmış da değildir: bir ürünün "önce en yakını
göster, kim müsaitse ona ver" biçimindeki ilk sürümü gerçekten böyle çalışır.

## 3. Veri kümesi

**Sentetiktir ve gerçek değildir.** Gerçek talep, sağlayıcı ve kabul davranışı Faz
15-16'dan önce yoktur.

| Senaryo            | Tohum    | Sağlayıcı | Talep | Gün |
| ------------------ | -------- | --------- | ----- | --- |
| `dense-single-day` | 20260921 | 40        | 12    | 1   |
| `wide-two-day`     | 20260922 | 90        | 30    | 2   |
| `sparse-supply`    | 20260923 | 14        | 18    | 1   |

Toplam **60 talep**, ortalama 18.2 aday/talep. Zaman kökü sabittir (2026-10-05):
"bugün"e bağlı bir benchmark her gün farklı sonuç verir ve yeniden üretilemez.

### 3.1 Gizli gerçek (ground truth) ve döngüsellikten kaçınma

Ölçümün en büyük riski **döngüsellik**ti: "doğru sağlayıcı"yı skor fonksiyonuyla
tanımlamak, proposed'a otomatik Recall@1 = 1.0 verir ve hiçbir şey söylemez.

Üreteç bu yüzden iki katman kurar:

- Her sağlayıcının **gizli** nitelikleri vardır (`reliability`, hizmet bazlı
  `affinity`). "Doğru eşleşme" bunlardan hesaplanır ve işlevsel biçimi skor
  fonksiyonundan farklıdır.
- Algoritmanın gördüğü alanlar (puan, kalite skoru, yetkinlik seviyesi) bu gizli
  niteliklerin **gürültülü yansımalarıdır**.

Gerçek cevap ayrıca her zaman **kısıtları sağlayan** bir sağlayıcıdır: atanması
yasak bir sağlayıcı "doğru cevap" olamaz. Uygun adayı olmayan talepler Recall@K'ya
hiç girmez (50/60 talep ölçüme girdi).

### 3.2 Kabul modeli

Gerçek kabul verisi yoktur. Kabul, teklifin kendisine bağlı **deterministik** bir
modelle simüle edilir (yol yükü + saat uygunluğu). Rastgele olsaydı iki kolu
karşılaştırmak algoritmayı değil zar atışını ölçerdi. **Mutlak bir kabul oranı
iddiası taşımaz**; yalnızca kollar arası karşılaştırma için anlamlıdır.

### 3.3 Doğrulayıcı koldan bağımsızdır

Kısıt ihlali, kolların kendi kontrolüyle değil ortak bir denetleyiciyle
(`verify_solution`) ölçülür. Kolun kendi kontrolüne güvenmek, hiçbir kuralı kontrol
etmeyen baseline'ı sıfır ihlalli gösterirdi. Denetim üç aileyi kapsar: aday bazlı
kısıtlar, takvim uygunluğu ve **çözüm içi tutarlılık** (çakışma, kapasite).

## 4. Sonuçlar

### 4.1 Aday bulma ve sıralama

| Metrik                  | baseline | proposed | Δ     |
| ----------------------- | -------- | -------- | ----- |
| Recall@1                | 0.24     | **0.46** | +0.22 |
| Recall@5                | 0.56     | **0.86** | +0.30 |
| Recall@10               | 0.90     | 0.94     | +0.04 |
| Ölçüme giren talep      | 50       | 50       | —     |
| Ortalama aday sayısı    | 18.2     | 18.2     | —     |
| Ortalama **uygun** aday | 12.25    | 4.93     | −7.32 |

Uygun aday sayısındaki düşüş bir kayıp değil, **ölçümün kendisidir**: baseline
yetkinlik, kapasite, mesafe sınırı ve tam müsaitlik kapsamasını hiç kontrol etmez,
bu yüzden atanamayacak adayları da "uygun" sayar.

### 4.2 Atama kalitesi

| Metrik                          | baseline | proposed | Δ         |
| ------------------------------- | -------- | -------- | --------- |
| Ham atama oranı                 | 1.00     | 0.82     | −0.18     |
| **Geçerli** atama oranı         | 0.30     | **0.82** | **+0.52** |
| Kabul edilen atama / talep      | 0.30     | **0.73** | **+0.43** |
| **Hard constraint ihlal oranı** | **0.70** | **0.00** | **−0.70** |

Baseline'ın 1.00 atama oranı yanıltıcıdır: atamalarının **%70'i uygulanamaz**.
Karşılaştırmanın anlamlı metriği geçerli atama oranıdır.

Baseline'ın ihlal dağılımı (toplam 60 atama):

| İhlal                           | Adet |
| ------------------------------- | ---- |
| `MISSING_REQUIRED_SKILL`        | 32   |
| `OVERLAPPING_ASSIGNMENTS`       | 18   |
| `CAPACITY_EXCEEDED_IN_SOLUTION` | 5    |
| `NOT_AVAILABLE`                 | 4    |
| `OUTSIDE_SERVICE_AREA`          | 1    |

Proposed'da **hiçbir ihlal yoktur** (T-18 hedefi: 0).

#### Kabul oranı: eşleştirilmiş okunmalıdır

Ham kabul oranı baseline 1.00, proposed 0.898 (Δ = −0.102). Bu fark büyük ölçüde
**seçilim yanlılığıdır**, algoritma farkı değil: kabul modeli yol yüküne bağlıdır
(§3.2) ve baseline'ın geçerli atama kümesi tanımı gereği en yakın tekliflerden
oluşur.

Her iki kolun da geçerli atadığı **18 ortak talep** üzerinde:

| Kol      | Kabul edilen | Oran  |
| -------- | ------------ | ----- |
| baseline | 18/18        | 1.000 |
| proposed | 17/18        | 0.944 |

Eşleştirilmiş fark −0.056; yani ham farkın yarısından fazlası kümelerin
farklılığından geliyordu.

### 4.3 Seyahat maliyeti — iki farklı şey ölçülüyor

Ayrım kritik ve ilk ölçümde karıştırılmıştı:

- **İlk ayak** (`first_leg`): sağlayıcının referans noktasından hizmet adresine.
  Bu, "hangi sağlayıcı seçildi" sorusunun mesafe sonucudur.
- **Gerçekleşen rota** (`realized_route`): aynı sağlayıcının o gün ardışık gittiği
  hizmetler arasındaki yol. **Optimizasyonun kısıtladığı ve cezalandırdığı maliyet
  budur.**

İlk ölçüm yalnızca ilk ayağı topluyor ama sonucu "seyahat maliyeti" diye
raporluyordu — yani rota optimizasyonunu, onu hiç görmeyen bir metrikle yargılıyordu.

**İlk ayak** (geçerli atama başına):

| Metrik          | baseline | proposed |
| --------------- | -------- | -------- |
| Ortalama süre   | 273 sn   | 821 sn   |
| Ortalama mesafe | 1.75 km  | 5.27 km  |

Eşleştirilmiş küme (18 ortak talep): proposed %152 **daha fazla** ilk ayak yolu
üretiyor. Ham ortalamaları doğrudan karşılaştırmak geçersizdi (seçilim yanlılığı);
eşleştirilmiş kıyas bulguyu **değiştirmiyor** — fark gerçek.

**Bu bir başarısızlık değil, ölçülmüş bir takastır.** Mesafe altı kriterden biridir
(ağırlık 0.15); proposed, mesafeyi yetkinlik/kalite/müsaitlik uyumu için bilinçli
olarak takas ediyor. Baseline ise tanımı gereği hep en yakını seçiyor — çünkü başka
hiçbir şeye bakmıyor. research-metrics §2.3'teki "travel time reduction" hedefi
**bu ağırlıklarla tutturulamaz** ve bu, ağırlık ayarının gerçek veriyle yapılması
gerektiğini gösteriyor (R-49).

### 4.4 Duyarlılık: yol cezası 12× — rota maliyetinde asıl sonuç

Aynı senaryolarda yalnızca `objective_version` değiştirildi (`objective-v2-travel`,
yol cezası dakika başına 5 → 60). Atama kümesi aynı büyüklükte kaldı, dolayısıyla
bu **temiz** bir karşılaştırma:

| Metrik                         | `objective-v1` | `objective-v2-travel` | Δ        |
| ------------------------------ | -------------- | --------------------- | -------- |
| Geçerli atama oranı            | 0.82           | 0.82                  | 0        |
| Recall@1 / @5                  | 0.46 / 0.86    | 0.46 / 0.86           | 0        |
| Kısıt ihlali                   | 0.00           | 0.00                  | 0        |
| **Gerçekleşen rota (toplam)**  | 12.590 sn      | **4.479 sn**          | **−%64** |
| İlk ayak (ortalama)            | 821 sn         | 678 sn                | −%17     |
| Eşleştirilmiş ilk ayak azalışı | —              | −%17.5 (49 talep)     |          |
| Kabul oranı                    | 0.898          | 0.878                 | −0.020   |
| Atanan adayın ortalama sırası  | 1.29           | 1.63                  | +0.34    |

Asıl bulgu burada: yol cezasını ağırlaştırmak **gerçekleşen rota maliyetini üçte
birine indiriyor** — atama oranından, recall'dan veya kısıt güvenliğinden hiç ödün
vermeden. Bedeli, daha düşük sıralı adayların seçilmesi (ortalama sıra 1.29 → 1.63)
ve küçük bir kabul kaybı.

**Varsayılan yine de değiştirilmedi.** İyi görünen katsayıyı seçip varsayılan yapmak
(metric shopping) ADR-0012 §5'in yasakladığı şeydir; üstelik "ortalama sıra"
kaybının gerçek kullanıcı memnuniyetine etkisi **ölçülmedi**. `objective-v2-travel`
kayıtlı bir sürüm olarak durur ve karar gerçek kabul/iptal verisiyle verilecek (R-49).

### 4.5 Gecikme

| Metrik                         | baseline | proposed   |
| ------------------------------ | -------- | ---------- |
| Talep başına sıralama p50      | 0.13 ms  | 0.17 ms    |
| Talep başına sıralama p95      | 0.18 ms  | 0.42 ms    |
| Senaryo uçtan uca p50          | 1.9 ms   | 75 ms      |
| Senaryo uçtan uca p95          | 4.4 ms   | 94 ms      |
| Optimizasyon runtime p50 / p95 | —        | 66 / 89 ms |
| Fallback oranı                 | —        | 0.00       |

> **Gecikme sayıları makineye bağlıdır ve tek yeniden üretilemeyen metriklerdir.**
> Diğer tüm değerler (recall, atama, ihlal, rota, kalibrasyon) tohumdan deterministik
> olarak üretilir ve çalıştırmalar arasında bit düzeyinde aynıdır. Yukarıdaki süreler
> bu raporun yazıldığı çalıştırmadandır.
>
> Ayrıca: senaryo sayısı 3 olduğu için uçtan uca ve optimizasyon **p95'i pratikte
> maksimumdur**. Yüzdelik olarak sunulması ölçülenden fazlasını ima etmemelidir.

Uçtan uca süre bir **senaryonun tamamı** içindir (12-30 talep birlikte), tek talep
için değil. Hiçbir senaryoda 5 sn'lik çözücü limitine takılınmadı.

Bu ölçümler AI servisinin içindedir; core tarafındaki aday havuzu sorgusu ayrı
ölçüldü: 2.000 sağlayıcı ve 50.000 rezervasyonla **~10 ms** (bkz.
[matching.md](../../architecture/matching.md) §2).

## 5. Sonuç

| İddia                                               | Durum                                         |
| --------------------------------------------------- | --------------------------------------------- |
| Kısıt + scoring, doğru adayı daha sık öne çıkarır   | ✅ Recall@1 0.24 → 0.46, Recall@5 0.56 → 0.86 |
| Uygulanabilir atama oranı artar                     | ✅ 0.30 → 0.82                                |
| Hard constraint ihlali sıfırlanır                   | ✅ 0.70 → 0.00                                |
| Küresel optimizasyon kapasite/çakışmayı çözer       | ✅ çözüm içi ihlal yok                        |
| Rota maliyeti amaç fonksiyonuyla kontrol edilebilir | ✅ yol cezası 12× → gerçekleşen rota −%64     |
| İlk ayak mesafesi baseline'dan iyi                  | ❌ **değil** (+%152); bilinçli bir takas      |
| Optimizasyon gerçek zamanlı bütçede kalır           | ✅ p95 89 ms, fallback 0                      |

## 6. Sınırlar

1. **Sentetik veri.** Üreteç ile skor fonksiyonu aynı fazda yazıldı; gizli gerçek ile
   gözlenebilir özellikler arasındaki ilişki bir **varsayımdır** ve gerçek dünyada
   daha zayıf olabilir (R-45 ile aynı sınıf risk).
   1b. **Gerçeğin "uygunluk" yarısı döngüseldir.** `_best_by_truth`, adayları proposed
   kolunun kendi `constraints.evaluate` fonksiyonuyla eler; yalnızca **hangisi en
   iyi** sorusu bağımsız (gizli niteliklerden). Yani Recall@K "kısıtları doğru
   uyguluyor muyuz" sorusunu ölçmez — onu bağımsız doğrulayıcı ölçer — "uygunlar
   arasından doğru olanı seçiyor muyuz" sorusunu ölçer.
2. **Kabul modeli simülasyondur.** Mutlak kabul oranı iddiası taşımaz.
3. **Ölçek sınırlı.** En büyük senaryo 90 sağlayıcı / 30 talep. Yüz binlerce
   sağlayıcılı bir havuzda CP-SAT davranışı ölçülmedi (R-16 açık kalıyor).
4. **Seyahat hedefi tutmadı** ve bu, ağırlık/amaç ayarının gerçek veriyle
   yapılması gerektiğini gösteriyor (R-49).
5. **Tek çalıştırma.** Tohum başına varyans ölçülmedi; üç senaryo farklı tohumlarla
   üretildi ama tekrar sayısı 1. Kararlar deterministik olduğu için tekrar aynı
   sonucu verir; ölçülmeyen şey **senaryo dağılımına** göre varyanstır.
6. **Kabul modeli yol yüküne fazla bağımlı.** `acceptance` fonksiyonunda yol yükü iki
   kez görünür (doğrudan 0.4 ağırlıkla, bir de `true_fit` içinden). Bu, kabul
   metriğini mesafe farklarına aşırı duyarlı kılıyor; eşleştirilmiş kıyas bunu
   kısmen düzeltiyor ama model gerçek veriyle değiştirilmeli.
