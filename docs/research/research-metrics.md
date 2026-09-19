# Research Metrics & Experiment Framework

TÜBİTAK açısından değerli olan "modern teknoloji kullandık" değil, **"şu teknik belirsizliği şu
deneyle çözdük, şu metrikle ölçtük, baseline'a göre şu kadar iyileştik"** anlatımıdır.

Kural: **metrik tanımı deneyden önce yazılır.** Sonradan iyi görünen metriği seçmek (metric
shopping) yapılmaz. Tek başına açıklamasız "%85 doğruluk" tipi ifade kullanılmaz; dataset tanımı,
metrik ailesi ve belirsizlik birlikte raporlanır.

## 1. Ar-Ge eksenleri ve baseline'lar

| Eksen | Teknik belirsizlik (Ar-Ge sorusu) | Baseline | Proposed |
|---|---|---|---|
| NLP | Türkçe serbest metin hizmet talebi, güvenilir biçimde yapılandırılmış iş kısıtlarına dönüştürülebilir mi? | kural/regex tabanlı parser | model tabanlı structured extraction + şema doğrulama + confidence |
| Matching | Çok kriterli kısıtlar altında doğru aday havuzu ve sıralaması üretilebilir mi? | basit filtre + mesafe sıralaması | hard constraints + ağırlıklı çok kriterli scoring |
| Optimization | Atama, kapasite, zaman penceresi ve seyahat hedefleri birlikte optimize edilebilir mi? | greedy / first-available atama | OR-Tools çok kriterli assignment |
| Safety | Hizmet oturumu telemetrisinde normal ile anomali ayrılabilir mi? | yalnız eşik kuralları | rules + ML anomaly hibriti |
| Platform | Karar motorları gerçek zamanlı iki taraflı pazaryerinde güvenilir gecikmeyle çalışabilir mi? | — (mutlak hedefler) | ölçülen p50/p95, RPS, error rate |

## 2. Metrik tanımları

### 2.1 NLP
| Metrik | Tanım | Ölçüm |
|---|---|---|
| Intent precision/recall/F1 | hizmet türü sınıflandırması | etiketli değerlendirme seti, sınıf bazlı + macro F1 |
| Slot extraction F1 | `service_type`, `duration_minutes`, `date`, `time_window`, `location`, `requirements` alan bazlı | alan bazlı exact/partial match F1 |
| Şema geçerlilik oranı | Pydantic doğrulamasından geçen çıktı yüzdesi | otomatik |
| Confidence kalibrasyonu | confidence ile gerçek doğruluk arasındaki uyum | reliability diagram / ECE |
| Netleştirme oranı | kullanıcıya soru sorulan talep yüzdesi | üretim + değerlendirme seti |
| Parser latency | p50/p95 | ölçüm |

### 2.2 Matching
| Metrik | Tanım |
|---|---|
| Recall@K | doğru/kabul edilen provider'ın ilk K aday içinde bulunma oranı (K = 1, 5, 10) |
| Acceptance rate | önerilen provider'ın teklifi kabul etme oranı |
| Assignment latency | talep → öneri arası p50/p95 |
| Match success | eşleşmenin tamamlanan booking'e dönüşme oranı |
| Hard constraint violation | önerilen adaylarda hard constraint ihlali sayısı (hedef: 0) |

### 2.3 Optimization
| Metrik | Tanım |
|---|---|
| Travel time reduction | baseline atamaya göre toplam seyahat süresi azalması (%) |
| Distance reduction | toplam mesafe azalması (%) |
| Provider utilization | uygun kapasitenin kullanım oranı |
| Constraint violation rate | çözümde ihlal edilen soft/hard kısıt oranı |
| Optimization runtime | p50/p95 ve timeout oranı |
| Fallback oranı | timeout nedeniyle fallback'e düşen çözüm yüzdesi |

### 2.4 Safety
| Metrik | Tanım |
|---|---|
| Anomaly recall | gerçek anomali vakalarının yakalanma oranı |
| False positive rate | normal oturumlarda üretilen yanlış alarm oranı |
| Detection latency | olay başlangıcı → alarm arası süre (p50/p95) |
| Panic flow completion | panic isteğinin kayıt + alert + hold zincirini tamamlama oranı (hedef: %100) ve p95 gecikme |
| Rule vs ML katkısı | her sinyal kaynağının tespitteki payı |

### 2.5 Platform
| Metrik | Hedef (başlangıç) |
|---|---|
| API p50 latency | ölçülecek, Faz 14'te hedef sabitlenir |
| API p95 latency | ölçülecek |
| RPS | yük testi ile |
| Error rate | < %1 (5xx) |
| Event processing lag | p95 ölçümü + alarm |
| Cache hit rate | ölçüm |
| Mobile crash-free sessions | Faz 16 |

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
