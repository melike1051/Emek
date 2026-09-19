# ADR-0013 — Yetkilendirme Modeli ve Audit Bütünlüğü

- Durum: Accepted (2026-09-20)
- Faz: 2 (uygulama), 12 (sertleştirme)
- Blueprint: §18, §7.1 (`audit_logs`)

## Bağlam

RBAC ve audit, KVKW/KVKK uyumunun ve IDOR savunmasının dayandığı iki kontroldür; Faz 0'ın ilk
ADR setinde ayrı bir karar olarak yazılmamışlardı. Ayrıca `audit_logs` Faz 2'den itibaren yazılmaya
başlıyor, ancak değişmezliğini sağlayan tek mekanizma (uygulama rolünden UPDATE/DELETE yetkisinin
alınması) Faz 12'ye planlanmıştı — arada audit izi sıradan, değiştirilebilir bir tablo olarak kalır.

## Karar

### Yetkilendirme

1. **Rol tek başına yetki değildir.** Her erişim kararı iki bileşenlidir: rol (`CUSTOMER`,
   `PROVIDER`, `ADMIN`, `SUPPORT`) **ve** kaynak sahipliği/ilişkisi. Rol kontrolü geçen bir istek
   ownership kontrolünü de geçmek zorundadır.
2. **Varsayılan reddetmedir (deny by default).** Yetkilendirme guard'ı olmayan endpoint yayına
   çıkmaz; bunu test zorlar (her route için authz testi zorunlu).
3. **Yetki kontrolü veri erişim katmanında da uygulanır**, yalnızca controller'da değil: sorgular
   kullanıcının erişebileceği kapsamla sınırlanır (`WHERE customer_id = :me` gibi), böylece
   guard'ı atlayan bir kod yolu veri sızdırmaz.
4. **Rol yetenek matrisi yazılıdır** ve Faz 2'de `docs/security/rbac-matrix.md` olarak kodla
   birlikte tutulur. Asgari kurallar:
   - `SUPPORT`: okuma + not/etiket ekleme. Ödeme serbest bırakma, refund, rol değişimi, silme,
     verification onayı **yapamaz**.
   - `ADMIN`: operasyonel aksiyonlar, hepsi audit'li. Üretim verisinde ham kimlik/konum verisine
     erişim ayrı ve loglanan bir yetkiye bağlıdır.
   - `PROVIDER`/`CUSTOMER`: yalnızca kendi kaynakları; karşı tarafın kişisel verisine yalnızca
     aktif booking bağlamında ve minimum alanla erişir.
5. Yetkisiz erişimde varlık bilgisi sızdırılmaz: uygun durumlarda `NOT_FOUND` döner.

### Audit bütünlüğü

6. **Rol ayrımı Faz 2'de yapılır** (tek migration): uygulama DB rolünün `audit_logs` üzerinde
   yalnızca INSERT ve SELECT yetkisi olur; UPDATE/DELETE yetkisi hiçbir uygulama rolüne verilmez.
   Bu, Faz 12'ye bırakılamaz çünkü tablo Faz 2'de yazılmaya başlar.
7. **Tamper evidence:** her satır `prev_hash` taşır ve `hash = H(prev_hash || canonical(row))`
   şeklinde zincirlenir. Zincir periyodik olarak doğrulanır; kopukluk alarm üretir.
   Bu, ayrıcalıklı bir rolün (migration rolü, superuser, sızmış erişim) geçmişi sessizce
   yeniden yazmasını **engellemez ama tespit edilebilir kılar**.
8. **Periyodik dışa aktarım:** audit kayıtları retention-locked bir hedefe (Cloud Storage
   retention policy / BigQuery) aktarılır. DB'deki kayıt tek kopya değildir.
9. **Audit kaydı asenkron değildir.** Kritik işlemin audit kaydı işlemle aynı transaction'da
   yazılır; "event ile sonra yazarız" yaklaşımı kabul edilmez (event ayrıca yayınlanabilir).
10. Audit kaydı **hassas veri taşımaz**: `old_value`/`new_value` içinde token, ham kimlik verisi,
    kart verisi bulunmaz; gerekliyse maskelenmiş/hash'lenmiş biçim yazılır.

## Gerekçe

Audit izi, üzerine yazılabiliyorsa audit değildir. Rol ayrımı bir migration'lık iştir ve onu
tablonun ilk kullanımından on faz sonra yapmak, aradaki tüm kayıtları güvenilmez kılar.
Hash zinciri ucuzdur ve ayrıcalıklı erişim senaryosunda tek tespit mekanizmasıdır.

## Sonuçlar

- `audit_logs`'a yazan kod, hash zincirini seri hale getirmek için tek yazma yolundan geçer;
  yüksek hacimli olaylar (ör. her okuma) audit'e yazılmaz — yalnızca tanımlı kritik işlemler.
- Zincir doğrulama işi ve alarmı Faz 12'de operasyonelleşir.
- Test zorunlu: T-30 (IDOR/rol), T-35 (uygulama rolüyle audit UPDATE/DELETE denemesi başarısız),
  T-36 (hash zinciri kopukluğu tespit edilir).

## Alternatifler

- **Yalnız uygulama seviyesinde "silmeyiz" disiplini (reddedildi):** kanıtlanamaz.
- **Blockchain/harici ledger (reddedildi):** blueprint §31 gereksiz teknoloji eklemeyi yasaklıyor;
  hash zinciri + retention-locked export aynı tespit gücünü çok daha düşük maliyetle verir.
- **Audit'i yalnızca log sistemine yazmak (reddedildi):** log retention kısa, yapısal sorgu zor,
  ilişkisel bağlam kaybolur.
