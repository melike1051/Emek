# ADR-0011 — Backend-First Geliştirme, Frontend Faz 15

- Durum: Accepted (2026-09-20)
- Faz: 0 (tüm proje boyunca geçerli)
- Blueprint: §30, §34

## Bağlam

Ekran odaklı başlamak (Flutter/Next.js ile dağınık ilerlemek) cazip ama tehlikeli: UI ihtiyaçları
veri modelini şekillendirir, sonuçta domain modeli ekran koleksiyonuna dönüşür ve booking/payment/
identity invariant'ları sonradan eklenmeye çalışılır.

## Karar

Geliştirme sırası: **domain model → database → API contract → backend → AI/optimization → safety
→ events → security/devops → web → mobile.**

- Faz 15'ten önce `apps/web` ve `apps/admin` içinde uygulama geliştirilmez.
- Faz 16'ya kadar `apps/mobile` geliştirilmez.
- Frontend, yayınlanmış API contract'a (`packages/api-contracts`) göre yazılır; contract'ı
  frontend ihtiyacı sonradan değiştiremez — değişiklik gerekiyorsa backend tarafında versiyonlanır.
- API contract, frontend yazılmadan **contract test** ile doğrulanır; "gerçek client bağlanınca
  görürüz" kabul edilmez.
- İstisna: geliştirici aracı niteliğinde minimal admin API tüketimi (curl/Postman koleksiyonu,
  OpenAPI UI) frontend sayılmaz.

## Gerekçe

Booking state machine, ödeme idempotency'si, kimlik tekilliği ve safety invariant'ları backend'de
doğru kurulmadan hiçbir ekran doğru çalışamaz. Tersi sırada ilerlemek, blueprint'in yasakladığı
"sadece demo için çalışan fake backend" sonucunu üretir.

## Sonuçlar

- Erken dönemde görsel çıktı yok; ilerleme testler, contract'lar ve ölçülebilir metriklerle gösterilir.
- TÜBİTAK demo ihtiyacı için Faz 10'da admin/ops **API**'si hazır olur; görsel panel Faz 15'te gelir.
  Ara dönemde demo, API akışı + metrikler üzerinden anlatılır.

**Bilinen raporlama riski (açık konu, karar kullanıcıya ait):** blueprint §17 admin/operations
yüzeyini "özellikle önemli" sayıyor ve §26'daki TÜBİTAK demo anlatısı tek bir booking'in bu ekran
üzerinden izlenmesine dayanıyor. Tüm görsel arayüzü 17 fazın 15'incisine bırakmak, hibe takvimi
altında demo hazırlığını sıkıştırabilir.

Seçenek (uygulanmadı, onay bekliyor): Faz 10'da kasıtlı olarak sade, **salt-okunur** bir iç ops
görünümü (tek sayfa, tasarım yatırımı yok, yalnızca mevcut admin API'sini okur) üretmek.
Bu bir "public frontend" değildir ve ADR-0011'in özünü — API contract'ların frontend tarafından
şekillendirilmemesi — bozmaz. Kullanıcı onay verirse bu ADR `Amended` olarak güncellenir.
Onay gelmediği sürece plan değişmez: Faz 15'ten önce arayüz geliştirilmez.
- Frontend fazına girildiğinde contract'lar dondurulmuş ve test edilmiş olur; entegrasyon süresi kısalır.

## Alternatifler

- **Paralel frontend (reddedildi):** proje talimatında ve blueprint §30'da açıkça yasak.
- **Frontend-first prototip (reddedildi):** domain modelini bozar, sonradan düzeltme maliyeti yüksek.
