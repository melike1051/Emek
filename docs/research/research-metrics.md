# Research Metrics & Experiment Framework

TÜBİTAK açısından değerli olan "modern teknoloji kullandık" değil, **"şu teknik belirsizliği şu
deneyle çözdük, şu metrikle ölçtük, baseline'a göre şu kadar iyileştik"** anlatımıdır.

Kural: **metrik tanımı deneyden önce yazılır.** Sonradan iyi görünen metriği seçmek (metric
shopping) yapılmaz. Tek başına açıklamasız "%85 doğruluk" tipi ifade kullanılmaz; dataset tanımı,
metrik ailesi ve belirsizlik birlikte raporlanır.

## 1. Ar-Ge eksenleri ve baseline'lar

| Eksen        | Teknik belirsizlik (Ar-Ge sorusu)                                                                         | Baseline                         | Proposed                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| NLP          | Türkçe serbest metin hizmet talebi, güvenilir biçimde yapılandırılmış iş kısıtlarına dönüştürülebilir mi? | kural/regex tabanlı parser       | model tabanlı structured extraction + şema doğrulama + confidence |
| Matching     | Çok kriterli kısıtlar altında doğru aday havuzu ve sıralaması üretilebilir mi?                            | basit filtre + mesafe sıralaması | hard constraints + ağırlıklı çok kriterli scoring                 |
| Optimization | Atama, kapasite, zaman penceresi ve seyahat hedefleri birlikte optimize edilebilir mi?                    | greedy / first-available atama   | OR-Tools çok kriterli assignment                                  |
| Safety       | Hizmet oturumu telemetrisinde normal ile anomali ayrılabilir mi?                                          | yalnız eşik kuralları            | rules + ML anomaly hibriti                                        |
| Platform     | Karar motorları gerçek zamanlı iki taraflı pazaryerinde güvenilir gecikmeyle çalışabilir mi?              | — (mutlak hedefler)              | ölçülen p50/p95, RPS, error rate                                  |

## 2. Metrik tanımları

### 2.1 NLP

| Metrik                     | Tanım                                                                                            | Ölçüm                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Intent precision/recall/F1 | hizmet türü sınıflandırması                                                                      | etiketli değerlendirme seti, sınıf bazlı + macro F1 |
| Slot extraction F1         | `service_type`, `duration_minutes`, `date`, `time_window`, `location`, `requirements` alan bazlı | alan bazlı exact/partial match F1                   |
| Şema geçerlilik oranı      | Pydantic doğrulamasından geçen çıktı yüzdesi                                                     | otomatik                                            |
| Confidence kalibrasyonu    | confidence ile gerçek doğruluk arasındaki uyum                                                   | reliability diagram / ECE                           |
| Netleştirme oranı          | kullanıcıya soru sorulan talep yüzdesi                                                           | üretim + değerlendirme seti                         |
| Parser latency             | p50/p95                                                                                          | ölçüm                                               |

### 2.2 Matching

| Metrik                    | Tanım                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Recall@K                  | doğru/kabul edilen provider'ın ilk K aday içinde bulunma oranı (K = 1, 5, 10)                                                       |
| Acceptance rate           | önerilen provider'ın teklifi kabul etme oranı                                                                                       |
| Assignment latency        | talep → öneri arası p50/p95                                                                                                         |
| Match success             | eşleşmenin tamamlanan booking'e dönüşme oranı                                                                                       |
| Hard constraint violation | önerilen adaylarda hard constraint ihlali sayısı (hedef: 0)                                                                         |
| **Geçerli** atama oranı   | kısıt denetiminden geçen atamaların talep sayısına oranı (Faz 7'de eklendi: ham atama oranı, kural tanımayan bir kolu 1.0 gösterir) |

### 2.2.1 Faz 7 ölçüm durumu

Matching ve optimization metrikleri [EXP-002](experiments/exp-002-matching-baseline-vs-optimized.md)
ile **sentetik** veri üzerinde ölçüldü. Kabul oranı simüle edilmiş bir modele dayanır
ve mutlak iddia taşımaz; gerçek kabul/tamamlanma verisi Faz 15-16'da toplanacak.

| Metrik                    | Durum                                                         |
| ------------------------- | ------------------------------------------------------------- |
| Recall@K (1/5/10)         | ✅ ölçüldü — 0.46 / 0.86 / 0.94 (baseline 0.24 / 0.56 / 0.90) |
| Acceptance rate           | ⚠️ simüle edildi — kollar arası karşılaştırma için geçerli    |
| Assignment latency        | ✅ ölçüldü — senaryo p95 98 ms; aday havuzu ~10 ms            |
| Match success             | ⏸️ üretim verisi gerektirir (Faz 15+)                         |
| Hard constraint violation | ✅ ölçüldü — **0** (hedef tutturuldu)                         |
| Geçerli atama oranı       | ✅ ölçüldü — 0.82 (baseline 0.30)                             |

### 2.3 Optimization

| Metrik                    | Tanım                                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Travel time reduction     | baseline atamaya göre toplam seyahat süresi azalması (%). **Eşleştirilmiş (paired) kümede ölçülür**: kolların geçerli atama kümeleri farklı olduğu için ham ortalama kıyası seçilim yanlılığı taşır (Faz 7 bulgusu). |
| Distance reduction        | toplam mesafe azalması (%)                                                                                                                                                                                           |
| Provider utilization      | uygun kapasitenin kullanım oranı                                                                                                                                                                                     |
| Constraint violation rate | çözümde ihlal edilen soft/hard kısıt oranı                                                                                                                                                                           |
| Optimization runtime      | p50/p95 ve timeout oranı                                                                                                                                                                                             |
| Fallback oranı            | timeout nedeniyle fallback'e düşen çözüm yüzdesi                                                                                                                                                                     |

### 2.3.1 Faz 7 ölçüm durumu

| Metrik                    | Durum                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| Travel time reduction     | ❌ **hedef tutmadı** — proposed %152 _fazla_ yol üretiyor (R-49) |
| Distance reduction        | ❌ aynı bulgu                                                    |
| Provider utilization      | ⏸️ üretim verisi gerektirir                                      |
| Constraint violation rate | ✅ 0.00 (baseline 0.70)                                          |
| Optimization runtime      | ✅ p50 64 ms / p95 94 ms, timeout oranı 0                        |
| Fallback oranı            | ✅ 0.00 (5 sn limitine hiç takılınmadı)                          |

Seyahat hedefinin tutmaması bir ölçüm hatası değil, **ağırlık/amaç ayarının
yapılmamış olmasının sonucudur**. Duyarlılık analizi (`objective-v2-travel`) %17.5
azalma gösteriyor ama varsayılan değiştirilmedi — iyi görünen katsayıyı seçip
varsayılan yapmak §"metric shopping" yasağına girer.

### 2.4 Safety

| Metrik                | Tanım                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Anomaly recall        | gerçek anomali vakalarının yakalanma oranı                                                  |
| False positive rate   | normal oturumlarda üretilen yanlış alarm oranı                                              |
| Detection latency     | olay başlangıcı → alarm arası süre (p50/p95)                                                |
| Panic flow completion | panic isteğinin kayıt + alert + hold zincirini tamamlama oranı (hedef: %100) ve p95 gecikme |
| Rule vs ML katkısı    | her sinyal kaynağının tespitteki payı                                                       |

### 2.4.1 Faz 8 ölçüm durumu ([EXP-004](experiments/exp-004-safety-anomaly.md), **sentetik**)

| Metrik                                  | Sonuç (sentetik, 360 oturum)                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| Recall / FPR @WARNING — yalnız kurallar | 0.881 / 0.04 (tek FP kaynağı cihaz uykusu, R-55)                                        |
| Recall / FPR @WARNING — hibrit (v2)     | 1.000 / 0.04 — ince bileşim (I06) yalnızca v2 model ile yakalanıyor (döngüsellik: R-63) |
| Recall @HIGH_RISK — kurallar → hibrit   | 0.638 → 0.756, FPR 0 → 0                                                                |
| Tespit gecikmesi p50 / p90 (hibrit)     | 600 / 3514 sn (120 sn çözünürlük)                                                       |
| Telemetri: gerçek / enjekte ret oranı   | < 0.0001 / 1.0                                                                          |
| Geofence durum doğruluğu                | 0.980; jitter ailesinde fazla geçiş 0                                                   |
| Panik zinciri tamamlama                 | 20/20 (simülasyon); gerçek yol integration testleriyle doğrulandı                       |
| Panik gecikmesi (yerel, tek istemci)    | sıralı p95 13.8 ms; 10 eşzamanlı p95 369.6 ms (R-54)                                    |

Her üretim değerlendirmesi `safety_risk_assessments`'a kural seti, toplama ve model
sürümüyle yazılır (alarm üretmeyenler dâhil): FPR'nin paydası gerçek veride de ölçülebilir.

### 2.5 Platform

| Metrik                     | Hedef (başlangıç)                     |
| -------------------------- | ------------------------------------- |
| API p50 latency            | ölçülecek, Faz 14'te hedef sabitlenir |
| API p95 latency            | ölçülecek                             |
| RPS                        | yük testi ile                         |
| Error rate                 | < %1 (5xx)                            |
| Event processing lag       | p95 ölçümü + alarm                    |
| Cache hit rate             | ölçüm                                 |
| Mobile crash-free sessions | Faz 16                                |

Not: Hedef değerler Faz 14'te gerçek ölçüme dayanarak sabitlenir; şimdiden uydurulmuş sayı yazılmaz.

## 3. Üretimde ölçüm altyapısı (ADR-0012)

Sürüm ve skor bilgileri üretim verisinde tutulur; deneyler bu veriye dayanır:

- `booking_requests`: `raw_text`, `structured_request`, `parser_version`, `parser_confidence`
- `booking_match_results`: `skill_score`, `availability_score`, `quality_score`, `distance_score`,
  `rating_score`, `preference_score`, `overall_score`, `algorithm_version`, `selected`
- optimization çalıştırması: `objective_version`, `weights_version`, runtime, ihlal sayısı, fallback flag
- `safety_events`: `risk_score`, `source` (`RULE`/`ML`/`USER`), safety model sürümü

## 4. Deney kaydı formatı

Her deney `docs/research/experiments/YYYY-MM-DD-<konu>.md` olarak kaydedilir:

```
## Hipotez
## Kurulum          (dataset sürümü, veri boyutu, ortam, donanım)
## Baseline         (sürüm + config)
## Proposed         (sürüm + config)
## Metrikler        (deneyden önce tanımlanmış)
## Sonuçlar         (tablo + belirsizlik/varyans)
## Yorum            (neden iyileşti/iyileşmedi)
## Tehditler        (dataset yanlılığı, küçük örneklem, overfitting riski)
## Karar            (sürüm kabul/red, sonraki adım)
```

## 5. Dataset yönetimi

- Gerçek kişisel veri repoda tutulmaz. Sentetik/anonimleştirilmiş örnekler + şema + üretim
  scripti versiyonlanır.
- Dataset sürümü (`v1`, `v2`) ve boyutu her deneyde belirtilir.
- Değerlendirme seti eğitim/prompt geliştirme sürecinden ayrı tutulur; sızıntı olursa deney geçersizdir.

## 6. ESG / etki metrikleri (Faz 11)

Operasyonel olaylardan türetilir: aktif kadın sağlayıcı sayısı, tamamlanan hizmet saati,
sağlayıcı başına kazanç dağılımı, bölgesel erişim, tekrar müşteri oranı, güvenlik olayı oranı.
Bu metrikler kişisel veri minimize edilerek (agregat düzeyde) üretilir.
