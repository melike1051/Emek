# Identity HMAC Anahtarı — Yeniden Doğrulama Göçü Prosedürü

Son güncelleme: 2026-09-23 (Faz 12). İlgili: ADR-0004 §5, ADR-0022 §7.

> **Bu bir anahtar rotasyonu prosedürü değildir.** Emek'te `identity_hash` anahtarının
> rotasyonu **yoktur** ve olmayacaktır. Bu belge, anahtarın yine de değişmek zorunda
> kaldığı istisnai durumda izlenecek yolu tanımlar.

## 1. Neden rotasyon yok

`identity_hash`, ham T.C. kimlik numarasının KMS'teki **non-exportable** bir anahtarla
üretilmiş HMAC-SHA256 özetidir ve mükerrer hesap engelinin tek kaynağıdır
(`uq_identity_records_hash`, sağlayıcıdan bağımsız partial unique index).

Anahtar değişirse aynı kişi için üretilen hash de değişir. Ham numara **hiçbir yerde
saklanmadığı** için (veri minimizasyonu — ADR-0004) eski hash'ler yeni anahtarla
**yeniden hesaplanamaz**. Sonuç: tekillik index'i anlamını kaybeder, aynı kişi ikinci
bir hesap açabilir hale gelir.

`hash_key_version` sütunu bu yüzden **teşhis amaçlıdır**: hangi kaydın hangi anahtar
sürümüyle üretildiğini gösterir, geçiş yapılmasını sağlamaz.

## 2. Anahtarın değişmesini gerektiren durumlar

| Durum                                         | Değerlendirme                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| KMS anahtar materyali sızdı                   | Sızan anahtar hash'i üretebilir ama ham numarayı vermez; yine de göç gerekir |
| KMS anahtarı yanlışlıkla imha edildi          | Yeni hash üretilemez; göç zorunlu                                            |
| Kriptografik zayıflık (HMAC-SHA256 kırılırsa) | Göç zorunlu                                                                  |
| "Rutin güvenlik hijyeni"                      | **Geçerli gerekçe değildir.** Maliyet, kullanıcı başına yeniden doğrulamadır |

## 3. Prosedür

Göç **otomatik değildir** ve tek seferde tamamlanmaz. Her kullanıcı yeniden doğrulama
yapana kadar sürer.

1. **Karar ve kayıt.** Göç kararı ADR ile kayda geçer; gerekçe ve etkilenen kayıt sayısı
   yazılır. `TODO(legal)`: KVKK bildirim yükümlülüğü (sızıntı senaryosunda) hukuk
   görüşüyle netleşmelidir.
2. **Yeni anahtar sürümü.** KMS'te yeni anahtar sürümü oluşturulur.
   `IDENTITY_HASH_KEY_VERSION` yeni sürüme ayarlanır. **Eski sürüm imha edilmez**: eski
   hash'lerin hangi anahtarla üretildiği bilinmeye devam etmelidir.
3. **Çift tekillik penceresi.** Geçiş süresince tekillik hem eski hem yeni hash üzerinden
   kontrol edilmelidir; aksi halde eski hash'li bir kullanıcı yeni anahtarla ikinci hesap
   açabilir. Bu, adapter içinde **iki hash** üretip ikisini de sorgulamak demektir ve
   ancak eski anahtar hâlâ HMAC üretebiliyorsa mümkündür (imha senaryosunda değildir).
4. **İmha senaryosu (eski anahtar kullanılamıyor).** Çift kontrol yapılamaz. Bu durumda
   tekillik garantisi geçici olarak **kaybedilir** ve bunu telafi etmenin tek yolu
   doğrulanmış tüm kullanıcıları `VERIFICATION_REQUIRED` durumuna düşürüp yeniden
   doğrulamaya zorlamaktır. Bu bir ürün kararıdır, teknik bir tercih değil.
5. **Yeniden doğrulama.** Kullanıcı normal doğrulama akışından geçer; adapter yeni
   anahtarla yeni `identity_hash` üretir ve `hash_key_version` güncellenir.
6. **Kapanış.** Eski sürümle kalan kayıt kalmadığında (`SELECT count(*) FROM
identity_records WHERE hash_key_version = '<eski>'` sıfır), eski anahtar sürümü
   devre dışı bırakılabilir.

## 4. İzleme

Göç sırasında takip edilecek tek metrik: eski sürümle kalan `identity_records` sayısı.
Bu sayı sıfıra inmeden göç bitmemiştir.

```sql
SELECT hash_key_version, count(*) FROM identity_records GROUP BY 1 ORDER BY 1;
```

## 5. Bu prosedürün bugünkü durumu

**Test edilmemiştir ve edilemez:** production KMS adapter'ı henüz bağlanmamıştır
(R-39, Faz 13). Bugün `IDENTITY_HASH_KEY_SOURCE=env` yalnızca geliştirmede çalışır;
production config'i `kms` ister ve adapter gelene kadar production başlatılamaz. Bu
bilinçli bir durumdur — sahte bir "KMS hazır" iddiası, göç prosedürünü de sahte yapardı.
