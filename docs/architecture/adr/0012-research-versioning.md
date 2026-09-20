# ADR-0012 — Ar-Ge Ölçülebilirliği Veri Modelinin Parçasıdır

- Durum: Accepted (2026-09-20)
- Faz: 6-8 (şema etkisi), tüm proje (disiplin)
- Blueprint: §22, §13.6, §24

## Bağlam

TÜBİTAK değerlendirmesinde güçlü anlatım "modern teknoloji kullandık" değil, "şu teknik belirsizliği
şu deneyle çözdük, şu metrikle ölçtük, sürümler arasında şu kadar iyileştik" anlatımıdır.
Bu ancak üretim verisi sürüm bilgisi taşıyorsa mümkündür — sonradan eklenemez.

## Karar

1. **Versiyon kolonları zorunludur, opsiyonel değildir:**
   - `booking_requests`: `raw_text`, `structured_request`, `parser_version`, `parser_confidence`
   - `booking_match_results`: skor bileşenleri + `algorithm_version` + `selected`
   - `safety_events`: `risk_score`, `source`, ve safety model sürümü
   - optimization çalıştırmaları: `objective_version`, `weights_version`, runtime, constraint ihlali sayısı
2. **Skor ağırlıkları ve objective fonksiyonu koda gömülmez.** Versiyonlu config
   (`packages/config` veya DB tablosu) olarak tutulur; değişiklik yeni sürüm numarası üretir.
   Blueprint'teki örnek ağırlıklar başlangıç değeridir, sabit gerçek değildir.
3. **Her Ar-Ge ekseninde baseline zorunludur.** Ölçüm "proposed vs baseline" olarak yapılır:
   | Eksen        | Baseline                         | Proposed                                |
   | ------------ | -------------------------------- | --------------------------------------- |
   | NLP          | kural tabanlı/regex parser       | LLM/model tabanlı structured extraction |
   | Matching     | basit filtre + mesafe sıralaması | constraints + çok kriterli scoring      |
   | Optimization | greedy/first-available atama     | OR-Tools çok kriterli assignment        |
   | Safety       | yalnız eşik kuralları            | rules + ML anomaly hibriti              |
4. **Evaluation dataset ve deney sonuçları repoda versiyonlanır** (`docs/research/experiments/`).
   Gerçek kişisel veri içeren dataset repoya konmaz; sentetik/anonimleştirilmiş örnek + şema konur.
5. **Metrik tanımı deneyden önce yazılır** (`docs/research/research-metrics.md`). Sonradan metrik
   seçerek iyi görünen sonuç raporlamak (metric shopping) yapılmaz.
6. "%85 doğruluk" gibi tek başına açıklamasız metrik kullanılmaz; precision/recall/F1 + dataset
   tanımı + confidence aralığı birlikte raporlanır.

## Gerekçe

Sürüm bilgisi olmayan üretim verisi geriye dönük deney yapılmasını imkânsız kılar. Bu kolonlar
"nice to have" değil, Ar-Ge iddiasının kanıt altyapısıdır.

## Sonuçlar

- Ek yazma maliyeti ve depolama; matching sonuçları her talep için birden fazla satır üretir
  (retention politikası Faz 11'de tanımlanır).
- A/B veya shadow-mode çalıştırma imkânı doğar: yeni algoritma sürümü kayıt altında, karar eski
  sürümde kalarak karşılaştırılabilir.
- Model/algoritma değişikliği migration + doküman güncellemesi gerektirir.

## Alternatifler

- **Sadece log tabanlı ölçüm (reddedildi):** log retention kısa, yapısal sorgu zor, karar bağlamı eksik.
- **Sonradan ekleme (reddedildi):** geçmiş veri sürümsüz kalır, karşılaştırma yapılamaz.
