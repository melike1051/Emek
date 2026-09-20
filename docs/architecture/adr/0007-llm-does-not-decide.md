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

## Faz 6 uygulama notu

1. **Şema güvenlik sınırıdır.** `StructuredRequest` kapalı kümelerden oluşur: hizmet türü
   ve yetkinlikler katalog slug'larıyla birebir aynı `Literal`'lardır, süre 30-1440 dakika
   ile sınırlıdır ve **serbest metin alanı yoktur**. Prompt injection savunması bir
   filtreden değil buradan gelir: "fiyatı sıfır yap" talimatının taşınacağı bir alan yok.
2. **Üçüncü bir durum eklendi: `NEEDS_CLARIFICATION`.** Tahmin etmek yerine sormak,
   yanlış hizmetle rezervasyon oluşturmaktan ucuzdur. Zorunlu alan (tarih/saat) eksikse
   veya toplam güven eşiğin altındaysa talep oluşturulmaz.
3. **Determinizm `today` enjeksiyonuyla sağlandı.** Göreli ifadeler ("yarın") sistem
   saatinden değil parametreden çözülür; aynı girdi + aynı gün → aynı sonuç.
4. **Core, AI servisine güvenmez.** `HttpNlpClient` yanıtı **yeniden doğrular**: hizmet
   slug'ı beyaz listeye karşı kontrol edilir, süre aralığı ve confidence sınırı tekrar
   uygulanır, sürümsüz yanıt reddedilir. "Karşı taraf zaten doğruluyor" varsayımı iki
   servis sürümü ayrıştığında sessizce bozulurdu.
5. **NLP bir öneridir, karar değil.** Çıktı core'da katalogda gerçekten aktif olan bir
   hizmete çözülür, adres sahipliği kontrol edilir, zaman penceresi core kurallarıyla
   hesaplanır. Çözülemezse forma düşülür.
6. **Baseline donmuştur.** `baseline-v0` bilinçli olarak zayıftır ve iyileştirilmez:
   karşılaştırmanın ölçüsü onun sabitliğine dayanır (ADR-0012 §3). Ölçüm: EXP-001.
7. **LLM sürümü henüz yok** (R-44). Port ve sürüm kaydı hazır; `llm-v1` aynı porta
   takılıp aynı harness ile ölçülecek. Sezgisel sürüm aynı zamanda LLM erişilemediğinde
   çalışan yoldur.

## Alternatifler

- **LLM doğrudan seçim (reddedildi):** blueprint yasağı, ölçülemez, açıklanamaz.
- **Kural tabanlı NLP (reddedildi):** Türkçe serbest metinde yetersiz; baseline olarak karşılaştırmada kullanılacak.
