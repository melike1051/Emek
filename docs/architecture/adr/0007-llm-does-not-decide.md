# ADR-0007 — LLM Talebi Anlar, Seçimi Deterministik Motor Yapar

- Durum: Accepted (2026-09-20)
- Faz: 6-7
- Blueprint: §13, §24, §34

## Bağlam

"AI ile eşleştirme" ifadesi iki farklı şeyi karıştırır: doğal dili anlamak ve kaynak atamak.
LLM'in doğrudan provider seçmesi test edilemez, açıklanamaz ve tekrarlanamaz sonuç üretir —
TÜBİTAK açısından ölçülebilir Ar-Ge iddiası kurulamaz, ürün açısından yanlış atama riski doğar.

## Karar

Sorumluluk ayrımı katı:

```
raw_text
  → [NLP/LLM]  "müşteri ne istiyor?"      → structured_request + confidence + parser_version
  → [candidate retrieval]  PostGIS/SQL     → aday havuzu
  → [hard constraints]     deterministik   → geçersiz adaylar elenir
  → [scoring]              ağırlıklı       → açıklanabilir skor bileşenleri
  → [soft constraints / optimization]  OR-Tools → atama
  → [explainability]                       → "neden bu provider?"
```

Kurallar:

1. LLM/NLP **yalnızca** structured extraction yapar: `service_type`, `duration_minutes`, `date`,
   `time_window`, `location`, `requirements`, `preferences`.
2. NLP çıktısı **şema doğrulamasından** geçer (Pydantic). Şemaya uymayan çıktı reddedilir;
   düşük confidence'ta kullanıcıya netleştirme sorulur veya yapılandırılmış form'a düşülür.
   LLM çıktısı asla doğrulanmadan SQL/iş kuralına girdi olmaz.
3. Provider seçimi deterministiktir: aynı girdi + aynı `algorithm_version` → aynı sonuç.
4. Hard constraint ihlali hiçbir skorla telafi edilemez (doğrulama, müsaitlik, gerekli skill,
   çakışma yokluğu, mesafe/süre eşiği, kapasite).
5. Her matching sonucu skor bileşenleriyle saklanır (`booking_match_results`): `skill_score`,
   `availability_score`, `quality_score`, `distance_score`, `rating_score`, `preference_score`,
   `overall_score`, `algorithm_version`, `selected`.
6. Explainability kullanıcıya gösterilen metin, **saklanan skor bileşenlerinden** üretilir; LLM'e
   "neden seçtin" diye sorulmaz. Açıklama başka kullanıcının kişisel verisini sızdırmaz.
7. Skor ağırlıkları koda gömülmez: versiyonlu config olarak tutulur, deneyle optimize edilir.
   Blueprint'teki örnek ağırlıklar (0.25/0.20/0.15/0.15/0.10/0.15) **başlangıç değeridir, gerçek değil.**

## Gerekçe

Ayrım test edilebilirlik, açıklanabilirlik ve ölçülebilirlik sağlar: NLP'yi F1 ile, matching'i
Recall@K ve acceptance rate ile ayrı ayrı ölçebiliriz. Tek monolitik LLM kararında bu imkânsızdır.

## Sonuçlar

- LLM servisi yavaş/erişilemez olduğunda yapılandırılmış form yolu çalışmaya devam eder.
- Optimization timeout'unda greedy/scoring-only fallback devreye girer ve bu durum sonuçta işaretlenir.
- Prompt injection yüzeyi: `raw_text` kullanıcı girdisidir; NLP katmanında talimat olarak
  yorumlanmaz, yalnızca veri olarak işlenir (Faz 6 güvenlik testi).

## Alternatifler

- **LLM doğrudan seçim (reddedildi):** blueprint yasağı, ölçülemez, açıklanamaz.
- **Kural tabanlı NLP (reddedildi):** Türkçe serbest metinde yetersiz; baseline olarak karşılaştırmada kullanılacak.
