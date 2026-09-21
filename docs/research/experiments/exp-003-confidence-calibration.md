# EXP-003 — Güven kalibrasyonu: ECE ölçümü (R-46 kapanışı)

- Tarih: 2026-09-21
- Faz: 7
- Ar-Ge ekseni: NLP confidence kalibrasyonu ([research-metrics](../research-metrics.md) §2.1)
- Ham sonuç: [`exp-003-confidence-calibration.json`](exp-003-confidence-calibration.json)
- Yeniden üretim:
  `cd services/ai && uv run python -m app.evaluation.run` (NLP) ve
  `uv run python -m app.evaluation.matching.run` (matching)

## 1. Neden bu deney

Faz 6, kalibrasyonu yalnızca **ortalama güven ile doğruluk farkı** olarak raporladı
ve bunu açıkça eksik ilan etti (R-46). Ölçü yanıltıcıdır: örneklerin yarısına 0.99
güvenle yanlış, yarısına 0.01 güvenle doğru diyen bir model ile her örneğe 0.5 veren
model **aynı ortalama farkı** üretir. Birincisi tamamen kalibresizdir.

Faz 7 açısından bu akademik bir ayrıntı değil: karar zinciri `parser_confidence`
eşiğine (`MIN_AUTO_CONFIDENCE = 0.6`) bakarak talep oluşturup oluşturmamaya, ve
Faz 7'de ikinci kez eşleştirme yapıp yapmamaya karar veriyor. Eşik, güvenin gerçek
doğrulukla ilişkili olduğu varsayımına dayanır.

## 2. Metrik

Eşit genişlikli kovalarla Expected Calibration Error:

```
ECE = Σ_b (n_b / N) · |acc_b − conf_b|
```

Yanında iki ölçü daha raporlanır, çünkü ECE tek başına yeterli değildir:

- **MCE** (en kötü kovadaki sapma): ortalama iyi görünürken tek bir kovada büyük
  sapma olabilir.
- **Brier skoru**: kalibrasyonu ve ayırt ediciliği birlikte cezalandırır. Yalnız
  ECE'ye bakmak, "her örneğe taban oranı ver" gibi ayırt edici olmayan ama iyi
  kalibre bir modeli mükemmel gösterirdi.

Kova sayısı 5 (dataset küçük; 10 kovada çoğu kova tek örnekli olur ve ECE gürültüye
döner).

## 3. NLP parser güveni

**"Doğru" tanımı Faz 7'nin tükettiği karara göre yapılır:** core, eşiği geçen bir
ayrıştırmadan hizmet türünü, günü ve saat penceresini alıp aday aramaya başlar.
Dolayısıyla bir tahmin ancak bu **üç alan da** doğruysa doğrudur. Yalnızca intent'e
bakmak, yanlış güne randevu veren bir ayrıştırmayı "doğru" sayar ve eşiği ölçüsüz
bırakırdı. Talep üretmeyen sonuçlar (netleştirme/red) örnekleme girmez.

| Ölçüm                            | `baseline-v0` | `heuristic-v1` |
| -------------------------------- | ------------- | -------------- |
| Örnek sayısı                     | 12            | 22             |
| Doğruluk                         | 0.083         | 0.864          |
| Ortalama güven                   | 0.500         | 0.767          |
| **ECE**                          | 0.417         | **0.164**      |
| MCE                              | 0.417         | 0.287          |
| Brier                            | 0.250         | 0.137          |
| Fazla özgüven (güven − doğruluk) | +0.417        | **−0.097**     |

Bulgular:

1. `heuristic-v1` baseline'dan **daha iyi kalibre** (ECE 0.417 → 0.164). Bu bir
   **ölçüm sonucudur, bir iyileştirme çalışmasının sonucu değildir**: kalibrasyonu
   düzelten hiçbir bileşen (sıcaklık ölçekleme, isotonic regression) yazılmadı.
2. `heuristic-v1` **az özgüvenlidir** (−0.097): gerçek doğruluğu (0.864) beyan
   ettiği güvenden (0.767) yüksek. Yani `MIN_AUTO_CONFIDENCE = 0.6` eşiği
   muhafazakâr tarafta — doğru ayrıştırmaların bir kısmını gereksiz yere
   netleştirmeye yolluyor olabiliriz. Bu, eşiği **düşürmek için** bir kanıt değil
   (örneklem 22); eşiğin yönünü bilmek için bir kanıt.
3. ECE hâlâ 0.164 ve MCE 0.287: kalibrasyon **iyi değil**, yalnızca ölçülmüş durumda.

## 4. Matching skoru bir olasılık mıdır?

`overall_score` sıralama için kullanılıyor. Sıralamada bir **ölçüt** olması yeterli;
ama ürün ya da operasyon bunu "bu sağlayıcının doğru seçim olma olasılığı" gibi
okursa yanılır. Bu yüzden ölçtük.

Ölçüm: EXP-002'nin proposed kolunda, atanan adayın `overall_score`'u güven;
"doğru", atanan sağlayıcının gizli gerçeğe göre en iyi uygun sağlayıcı olmasıdır.

| Ölçüm         | Değer  |
| ------------- | ------ |
| Örnek sayısı  | 49     |
| Doğruluk      | 0.367  |
| Ortalama skor | 0.814  |
| **ECE**       | 0.467  |
| MCE           | 0.510  |
| Brier         | 0.444  |
| Fazla özgüven | +0.446 |

Reliability tablosu:

| Kova      | Örnek | Ortalama skor | Doğruluk |
| --------- | ----- | ------------- | -------- |
| 0.0 – 0.2 | 0     | —             | —        |
| 0.2 – 0.4 | 0     | —             | —        |
| 0.4 – 0.6 | 1     | 0.490         | 1.000    |
| 0.6 – 0.8 | 17    | 0.742         | 0.353    |
| 0.8 – 1.0 | 31    | 0.863         | 0.355    |

**Sonuç: `overall_score` kalibre bir olasılık değildir ve öyle sunulmamalıdır.**
0.86 ortalama skorlu atamaların yalnızca %35'i gizli gerçeğin en iyisi. Üstelik
0.6-0.8 ile 0.8-1.0 kovalarının doğruluğu neredeyse aynı (0.353 vs 0.355): skor bu
aralıkta ayırt edici bile değil.

Bu beklenen bir sonuçtur ve **bir kusur değil, bir kategori farkıdır**: `overall_score`
olasılık olarak eğitilmiş bir çıktı değil, ağırlıklı bir sıralama ölçütüdür. Onu
olasılık gibi ölçmek, bir termometreyi kilogram cinsinden yanlış bulmaya benzer.

Ölçümün değeri kalibrasyonu "düzeltmek" değil, iki şeyi kanıta bağlamaktır:

1. Skor, olasılık olarak **sunulamaz** — bu artık varsayım değil, ölçülmüş bir sonuç
   ve API sözleşmesinde skoru dışarı vermeme kararını (bkz.
   [matching.md](../../architecture/matching.md) §8) doğrudan destekliyor.
2. Skor, 0.6-0.8 ile 0.8-1.0 aralığında **ayırt edici değil** (doğruluk 0.353 vs
   0.355). Bu, sıralama ölçütü olarak da bir sınırdır ve ağırlık ayarı çalışmasının
   (R-49) bakması gereken yerdir.

## 5. Kararlar

1. **R-46 kapandı**: ECE/MCE/Brier ve reliability tablosu ölçülüyor, raporlanıyor ve
   testle korunuyor (`tests/test_calibration.py`).
2. `MIN_AUTO_CONFIDENCE` **değiştirilmedi**. 22 örneklik bir sette ölçülen az
   özgüven, eşiği gevşetmek için yeterli kanıt değil.
3. `overall_score` **müşteriye açılmaz** ve hiçbir yerde olasılık olarak sunulmaz.
4. NLP kalibrasyonu **iyileştirilmedi**, yalnızca ölçüldü. Yeni risk R-50 bununla
   ilgilidir; matching skorunun ECE'si ise düzeltilecek bir kusur olarak
   kaydedilmez (yukarıdaki kategori farkı), ağırlık ayarına girdi olarak R-49'a
   bağlanır.

## 6. Sınırlar

- NLP seti 22 ölçülebilir örnek, matching seti 49 atama içeriyor. Kova başına örnek
  sayısı düşük; ECE'nin kendisinin belirsizliği hesaplanmadı (güven aralığı yok).
- Matching kalibrasyonu **sentetik** gizli gerçeğe karşı ölçüldü (EXP-002 §3.1
  sınırları aynen geçerli).
- Kalibrasyon ölçümü, dataset ile parser sözlüğünün aynı fazda yazılmış olmasından
  etkilenir (R-45).
