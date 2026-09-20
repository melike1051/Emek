# EXP-001 — NLP: kural tabanlı baseline vs Türkçe'ye duyarlı sezgisel parser

- Tarih: 2026-09-20
- Faz: 6
- Ar-Ge sorusu (research-metrics.md §1): _Türkçe serbest metin hizmet talebi, güvenilir
  biçimde yapılandırılmış iş kısıtlarına dönüştürülebilir mi?_
- Ham sonuç: [`exp-001-nlp-baseline-vs-heuristic.json`](exp-001-nlp-baseline-vs-heuristic.json)
- Yeniden üretim: `cd services/ai && uv run python -m app.evaluation.run`

## Kurulum

|          |                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline | `baseline-v0` — küçük harfe çevir, anahtar kelime ara, sabit süre ata                                                                                                                 |
| Proposed | `heuristic-v1` — Türkçe normalizasyon (`I/İ`, aksan katlama, ek listesine dayalı çekim tanıma), kanıt ağırlıklı hizmet skorlaması, zaman/süre/yetkinlik çıkarımı, kanıta dayalı güven |
| Dataset  | 24 sentetik örnek (`services/ai/data/evaluation/requests.jsonl`)                                                                                                                      |
| Ortam    | aynı harness, aynı set, aynı kod yolu; `today` her örnekte sabit                                                                                                                      |

**Dataset sınırları — dürüst okuma için:** 24 örnek küçüktür ve güven aralığı geniştir;
bu sonuç "Türkçe NLP çözüldü" demek değildir. Set **sentetiktir**: gerçek kullanıcı
metinlerinin yazım hataları, argo ve eksiltili anlatım çeşitliliğini temsil etmez
(ADR-0012 §4 gereği gerçek kişisel veri repoya konmaz). Örnekler ve proposed parser'ın
sözlüğü aynı fazda yazıldığı için **sözlük–set yakınlığı** riski vardır; bu risk
R-45 olarak kayıtlıdır ve Faz 15-16'da gerçek kullanıcı metinleriyle bağımsız bir
hold-out set kurulacaktır.

## Sonuçlar

| Metrik                                   | baseline-v0 | heuristic-v1 | Δ       |
| ---------------------------------------- | ----------- | ------------ | ------- |
| Intent macro F1                          | 0.5535      | **0.9750**   | +0.4215 |
| Intent accuracy                          | 0.5000      | **0.9583**   | +0.4583 |
| Slot macro F1                            | 0.1875      | **0.9320**   | +0.7445 |
| Şema geçerlilik oranı                    | 1.0000      | 1.0000       | 0       |
| Netleştirme oranı                        | 0.5000      | 0.2500       | −0.2500 |
| Netleştirme recall'ı                     | 0.5000      | **1.0000**   | +0.5000 |
| Ortalama güven                           | 0.2500      | 0.7029       | —       |
| Kalibrasyon farkı (\|güven − doğruluk\|) | 0.2500      | 0.2554       | +0.0054 |

### Slot bazında F1

| Slot               | baseline-v0 | heuristic-v1 |
| ------------------ | ----------- | ------------ |
| `duration_minutes` | 0.3333      | 1.0000       |
| `service_date`     | 0.4167      | 1.0000       |
| `time_window`      | 0.0000      | 0.8947       |
| `requirements`     | 0.0000      | 0.8333       |

### Sınıf bazında (heuristic-v1)

| Hizmet              | P    | R    | F1   | destek |
| ------------------- | ---- | ---- | ---- | ------ |
| `standart-temizlik` | 1.00 | 1.00 | 1.00 | 9      |
| `detayli-temizlik`  | 1.00 | 1.00 | 1.00 | 2      |
| `tasinma-temizligi` | 1.00 | 1.00 | 1.00 | 1      |
| `yasli-bakimi`      | 0.67 | 1.00 | 0.80 | 2      |
| `cocuk-bakimi`      | 1.00 | 1.00 | 1.00 | 3      |
| `hasta-refakati`    | 1.00 | 1.00 | 1.00 | 1      |
| `gunluk-yemek`      | 1.00 | 1.00 | 1.00 | 2      |
| `haftalik-mealprep` | 1.00 | 1.00 | 1.00 | 1      |

## Hata analizi

**Bu bölüm koddan üretilir**, elle yazılmaz (`proposed_errors` alanı, `collect_errors`).
İlk sürümünde elle yazılmıştı ve **yanlış örnekleri** işaret ediyordu; bu, gerçek bir
hatanın (ek çözümleme) fark edilmesini geciktirdi. Artık her sapma dataset'ten
otomatik çıkarılıyor.

Kalan 3 sapma (24 örnekte):

| Örnek    | Alan           | Gold             | Tahmin                 | Yorum                                                                                                                                                                                                                                                                                                                |
| -------- | -------------- | ---------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cl-004` | `requirements` | `derin-temizlik` | —                      | "Detaylı **bahar** temizliği": çok kelimeli kanıt (`detayli temizlik`) araya giren kelime yüzünden tutmuyor. Gerçek bir eksik; çözümü hizmet türünden yetkinlik türetmek olurdu ki bu NLP değil iş kuralıdır (Faz 7).                                                                                                |
| `ed-003` | `service_type` | —                | `yasli-bakimi`         | "Yaşlı bakımı mı temizlik mi karar veremedim": bilinçli belirsiz. Parser en yüksek kanıtı seçiyor **ama** düşük güven üretip netleştirme soruyor. Operasyonel davranış doğru; yine de tahmin bir yanlış pozitif olarak sayılıyor ve `yasli-bakimi` precision'ını 0.67'ye düşüren şey budur. Harness bunu gizlemiyor. |
| `ed-003` | `requirements` | —                | `yasli-bakim-deneyimi` | Aynı örneğin yan etkisi.                                                                                                                                                                                                                                                                                             |

Hata listesi bir **etiket hatası** da yakaladı: `cl-007` ("haftaya pazartesi", bugün
pazartesi) için gold 2026-03-16 yazılmıştı; doğrusu bir sonraki pazartesi olan
2026-03-09'dur. Etiket düzeltildi. Elle yazılan analizde bu görülmemişti.

## Yorum

**Kazanç nerede?** En büyük fark slot çıkarımında (+0.74). Baseline saat aralığı ve
yetkinlik hiç çıkarmıyor (F1 = 0), süreyi de metinden okumuyor — sabit varsayılan
kullanıyor. Intent tarafındaki fark ise büyük ölçüde **Türkçe normalizasyondan** geliyor:
"TEMİZLİĞE İHTİYACIM VAR" gibi bir girdi baseline'da hiç eşleşmiyor, çünkü Python'un
`str.lower()`'ı `İ → i̇` üretiyor ve ek almış biçim anahtar kelimeyle tutmuyor.

**Netleştirme recall'ı 0.50 → 1.00** en operasyonel sonuç: proposed, gerçekten belirsiz
olan örneklerin hepsinde soru soruyor; baseline yarısında tahmin yürütüp yanlış talep
üretiyor. Aynı anda toplam netleştirme oranı **düşüyor** (0.50 → 0.25) — yani proposed
daha az soruyor ama doğru yerlerde soruyor. Bu ikisi birlikte okunmalı: tek başına düşük
netleştirme oranı iyi sayılamaz, çünkü tahmin yürüten bir parser de az soru sorar.

**Kalibrasyon iyileşmedi, hafifçe kötüleşti (0.2500 → 0.2554) ve bu bir zayıflıktır.**
Baseline'ın farkının düşük görünmesinin sebebi iyi kalibre olması değil; sabit 0.5
güveniyle düşük doğruluğun tesadüfen yakın düşmesi. Proposed hem doğruluğu hem güveni
yükseltti ama güvenini doğruluğundan biraz daha hızlı yükseltti. Ölçüm şu an ortalama
üzerinden yapılıyor; gerçek kalibrasyon için **reliability diagram / ECE** gerekiyor ve
bu Faz 7'ye kaldı (R-46). Netleştirme eşiği (`MIN_AUTO_CONFIDENCE = 0.6`) bu belirsizlik
nedeniyle muhafazakâr seçildi.

## Karar

`heuristic-v1` varsayılan sürüm olarak alındı (`AI_PARSER_VERSION`). `baseline-v0` repoda
**donmuş** olarak kalıyor: karşılaştırmanın ölçüsü onun sabitliğine dayanıyor, iyileştirme
fikirleri yeni bir sürüme gider (ADR-0012 §3).

Model (LLM) tabanlı `llm-v1` aynı porta takılacak ve aynı harness ile bu iki sürümün
üzerine ölçülecek (R-44). Sağlayıcı sözleşmesi olmadan LLM sürümü yazmak, ölçülemeyen
bir iddia olurdu.
