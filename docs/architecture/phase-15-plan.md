# Faz 15 — Web Frontend: Plan ve Ekran Envanteri

Durum: **kod tamam, yalnız yerelde doğrulandı** (dağıtım: R-105, R-107; CI'da E2E: R-106). ✅ Adım 1 (ADR-0024, `packages/ui`, `packages/api-client`) ·
✅ Adım 2 (`apps/web` iskeleti: auth, rol seçimi, kabuk, hesap) ·
✅ Adım 3 (müşteri akışı: talep → eşleşme → randevu → ödeme → güvenlik/kanıt → değerlendirme/itiraz) ·
✅ Adım 4 (sağlayıcı akışı: profil/başvuru, hizmet/beceri/bölge/müsaitlik, randevu geçişleri, kanıt yükleme) ·
✅ Adım 5 (`apps/admin`: operasyon ekranları) ·
✅ Adım 6 (Playwright E2E, code/security/performance review, docs).

Girdiler: `packages/api-contracts/openapi.json` (≈100 uç), mevcut RBAC (`docs/security/rbac-matrix.md`),
booking state machine, Google Stitch tasarım paketi (11 ekran + `DESIGN.md` "Artisanal Trust & Local Labor").
Stitch paketi **görsel kaynak**tır, site haritası değildir; envanter backend yeteneklerinden türetildi.

## 1. Mimari kararlar (ADR-0024 olarak yazılacak)

| Konu            | Karar (öneri)                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uygulamalar     | İki Next.js (App Router) uygulaması: `apps/web` (müşteri + sağlayıcı, tek oturum, rol bağlamı değişimi) ve `apps/admin` (ADMIN/SUPPORT). Repo yapısı zaten böyle — taşıma yok.                |
| Tasarım sistemi | Yeni `packages/ui`: Stitch `DESIGN.md` token'ları → CSS custom properties + React bileşenleri (Button, Card, Badge, Input, Avatar, StatusPill, EmptyState…). İki uygulama da buradan tüketir. |
| Stil            | CSS Modules + token değişkenleri (ek runtime bağımlılığı yok). Fontlar `next/font` ile (Libre Caslon Text, IBM Plex Sans).                                                                    |
| API tipleri     | Elle yazılmış, kaynak DTO'ya işaret eden tipler + ince tipli `fetch` istemcisi (`packages/api-client`). OpenAPI şemaları boş olduğu için üretim yapılmaz (ADR-0024, R-99).                    |
| Auth            | Firebase Auth Web SDK (telefon OTP) → ID token → `POST /auth/session`. Yerelde `AUTH_PROVIDER=mock` için `mock:<subject>` token'lı geliştirici girişi (yalnız dev build'de).                  |
| App Check       | Web için reCAPTCHA Enterprise sağlayıcısı; `X-Firebase-AppCheck` başlığı istemcide eklenir. Dev'de backend `APP_CHECK_ENABLED=false`.                                                         |
| Ağ / CORS       | Backend'de CORS açılmadı. Öneri: Next.js `rewrites` ile aynı-origin `/api/v1/*` proxy → CORS gerekmez. (Alternatif: backend'e allowlist'li CORS.) R-53: proxy hop sayısı dokümante edilir.    |
| Veri çekme      | TanStack Query (cache, retry, optimistic olmayan mutasyonlar). Kritik mutasyonlar `Idempotency-Key` başlığı üretir.                                                                           |
| Test            | Vitest + Testing Library (bileşen/hook), Playwright (kritik akış E2E, mock auth + gerçek API). `npm run lint/typecheck/test` workspace'lere eklenir.                                          |
| Dil             | Arayüz Türkçe; metinler bileşenlerin yanında (tek dil — i18n katmanı/kütüphanesi eklenmez).                                                                                                   |

## 2. Ekran envanteri

Kısaltmalar — **S**: Stitch referansı var · **Y**: yeni tasarlanacak (aynı dil) · Tüm listeler: loading skeleton, boş durum, hata (API `code` → `docs/api/error-codes.md` mesajı), 401→giriş, 403→yetkisiz sayfa.

### 2.1 Ortak (apps/web)

| Rota       | Akış / durumlar                                                   | API                                                                            | Tasarım        |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------- |
| `/giris`   | Telefon OTP, hata/yeniden gönder, oran sınırı (429) mesajı        | Firebase, `POST /auth/session`                                                 | Y              |
| `/rol-sec` | İlk girişte müşteri/sağlayıcı profili oluşturma                   | `POST /customers/profile`, `POST /providers/profile`                           | S (rol seçimi) |
| `/kimlik`  | Doğrulama oturumu başlat → sağlayıcı yönlendirmesi → durum takibi | `POST /verification/session`, `GET …/session/{id}`, `GET /verification/status` | S (NFC e-ID)   |
| `/hesap`   | Kullanıcı bilgisi, roller, adresler (ekle/sil)                    | `/users/me`, `/addresses`                                                      | S (Profilim)   |

### 2.2 Customer Web

| Rota                        | Akış / durumlar                                                                              | API                                                                                         | Tasarım                                    |
| --------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `/` (Keşfet & Talep)        | Doğal dil talebi + hızlı kategori; kategori/hizmet katalogu                                  | `POST /booking-requests/from-text`, `/service-categories`, `/services`                      | S                                          |
| `/talep/[id]`               | Parse sonucunu gözden geçir/düzelt (düşük `parser_confidence` uyarısı) → eşleştir            | `GET /booking-requests/{id}`, `POST /booking-requests`, `POST …/match`                      | Y                                          |
| `/talep/[id]/eslesme`       | Aday listesi + açıklanabilirlik (skor gerekçeleri), boş sonuç, → booking oluştur             | `GET …/match`, `POST /bookings`                                                             | S (kart) / Y (açıklama)                    |
| `/randevular`               | Aktif/geçmiş sekmeleri, durum pill'leri                                                      | `GET /bookings`                                                                             | S                                          |
| `/randevular/[id]`          | Durum zaman çizelgesi, iptal, ödeme yetkilendirme/yeniden yetki, onay, değerlendirme, itiraz | `/bookings/{id}`, `/history`, `/cancel`, `/transitions`, `/payment`, `/review`, `/disputes` | Y (Stitch kart dili)                       |
| `/randevular/[id]/guvenlik` | Aktif oturum: geofence/risk özeti, panik butonu (anlık, onay adımı tek)                      | `GET /bookings/{id}/safety-session`, `POST …/panic`                                         | S (Güvenlik & Oturum)                      |
| `/randevular/[id]/kanit`    | Before/after dosyaları, sha256, kısa ömürlü indirme                                          | `GET /bookings/{id}/documents`, `/documents/{id}/download-url`                              | S (Dijital İspat)                          |
| `/saglayici/[userId]`       | Değerlendirmeler (salt okunur)                                                               | `GET /users/{id}/reviews`                                                                   | S (zanaatkar profili) — **kısmi**, bkz. §3 |

### 2.3 Provider Web

| Rota                            | Akış / durumlar                                                                    | API                                                                     | Tasarım               |
| ------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------- |
| `/panel`                        | Başvuru durumu (DRAFT/PENDING_REVIEW/APPROVED/REJECTED/SUSPENDED) + bekleyen işler | `GET /providers/me`, `GET /bookings`                                    | Y                     |
| `/panel/profil`                 | Profil düzenle, başvuruyu gönder                                                   | `PATCH /providers/me`, `POST …/submit`                                  | S (Profilim/Cüzdan)   |
| `/panel/hizmetler`              | Beceri + hizmet ekle/sil                                                           | `/providers/me/skills`, `/services`, `/skills`                          | Y                     |
| `/panel/bolgeler`               | Hizmet bölgesi (merkez + yarıçap) ekle/sil                                         | `/providers/me/service-areas`                                           | Y                     |
| `/panel/musaitlik`              | Haftalık müsaitlik matrisi                                                         | `/providers/me/availability`                                            | S (müsaitlik matrisi) |
| `/panel/randevular[/id]`        | Onayla/reddet, varış→check-in→başla→check-out geçişleri, before/after yükleme      | `/bookings/{id}/confirm`, `/transitions`, `POST /documents`, `/confirm` | S (Randevular) / Y    |
| `/panel/randevular/[id]/oturum` | Oturum ekranı + panik. **Telemetri web'den gönderilmez** (mobil, Faz 16)           | `safety-session`, `panic`                                               | S                     |

### 2.4 Admin / Operations Web (apps/admin)

SUPPORT tüm ekranları okur; yazma butonları rolüne göre gizlenir **ve** backend 403'ü ayrıca ele alınır.

| Rota               | Akış                                                                                          | API                                                                | Tasarım                  |
| ------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| `/` Genel bakış    | Sistem sağlığı, DLQ/bildirim özeti, eşleştirme istatistikleri                                 | `/ops/health`, `/matching/admin/stats`, `/analytics/export/status` | Y                        |
| `/saglayicilar`    | Onay kuyruğu, onayla/reddet/askıya al/geri al (gerekçeli)                                     | `/providers/queue`, `…/approve                                     | reject                   | suspend | reinstate` | Y   |
| `/kimlik-kurtarma` | Kurtarma kuyruğu (R-36: taraf olan operatör onaylayamaz — backend hatası gösterilir)          | `/verification/recovery-requests*`                                 | Y                        |
| `/randevular`      | Filtre + cursor sayfalama, detay/geçmiş                                                       | `/bookings/admin`, `/bookings/{id}/history`                        | Y                        |
| `/odemeler`        | Liste; release/refund/reauthorize (çift onay diyaloğu)                                        | `/payments/admin`, `/payments/{id}/*`                              | Y                        |
| `/itirazlar`       | Liste + çözüm                                                                                 | `/disputes/admin`, `/disputes/{id}/resolve`                        | Y                        |
| `/guvenlik`        | Oturumlar + event triyajı, risk ayarla, kapat, değerlendir; ham konum **zorunlu gerekçe** ile | `/safety/operator/*`                                               | Y (Stitch güvenlik dili) |
| `/operasyon`       | DLQ, bildirim işleri, audit zinciri doğrulama, retention sweep                                | `/ops/*`                                                           | Y                        |
| `/mutabakat`       | Mutabakat koşuları/farklar, çalıştır, çöz                                                     | `/analytics/reconciliation*`                                       | Y                        |

## 3. Backend boşlukları (Stitch'te var, API'de yok)

Stitch "Yakınınızdaki Usta Zanaatkarlar" listesi ve herkese açık sağlayıcı profili gösteriyor; backend'de
**sağlayıcı arama / public profil ucu yok** — keşif AI talep → matching zinciriyle yapılıyor (CLAUDE.md: seçim
LLM'e değil zincire ait). Öneri: Faz 15'te keşif **talep-odaklı** kalır; public profil yalnızca değerlendirmeler
ile sınırlı. `GET /providers/{id}/public` gibi bir uç gerekiyorsa ayrı karar (RBAC + PII minimizasyonu).
Ayrıca: bildirim listesi ucu yok (Stitch'teki zil ikonu) — R-77 kapanmadan eklenmez; cüzdan/kazanç ucu yok.
"Sıfır Gizli Komisyon" gibi pazarlama iddiaları `TODO(legal)`.

## 4. Uygulama sırası (alt adımlar)

1. ADR-0024 + `packages/ui` (token'lar, temel bileşenler, test) + `packages/api-client` (üretilmiş tipler).
2. `apps/web` iskeleti: auth, rol seçimi, layout/navigasyon, hata/boş durum desenleri, CI entegrasyonu.
3. Customer akışı: talep → eşleşme → booking → ödeme → güvenlik/kanıt → değerlendirme/itiraz.
   _Uygulama notları (adım 3):_ `POST …/match` rezervasyonu **kendisi** oluşturur — web `POST /bookings`
   çağırmaz. Ödeme yetkilendirmesi senkron döner (booking doğrudan `SCHEDULED`); yeniden yetkilendirme
   yalnız ADMIN'dedir, müşteriye bilgi gösterilir. "Düzelt" mevcut talebi değiştirmez (PATCH ucu yok),
   formla **yeni** talep açar. Panik `Idempotency-Key` taşımaz (ADR-0008 §3). Açık kalanlar: R-100 (PSP
   sayfası), R-101 (geocoding). Değerlendirme `COMPLETED` ister; `CUSTOMER_CONFIRMED → COMPLETED` SYSTEM
   geçişi olduğundan bu adımın gerçek-backend E2E koşusunda değerlendirme formu yalnız birim testle doğrulandı.
4. Provider akışı: profil/başvuru, hizmet/bölge/müsaitlik, booking geçişleri, dosya yükleme.
   _Uygulama notları (adım 4):_ Ret ayrı bir uç değildir — `PROVIDER_PENDING`'de gerekçeli `cancel`dır.
   Hazırlık listesi (tanıtım, hizmet, bölge, 30 günlük müsaitlik, kimlik) yol göstericidir; backend
   başvuruyu buna bağlamaz, web yalnızca ilk dördü tamamlanınca gönderime izin verir (kimlik eşleştirmeyi
   bloklar, başvuruyu değil). Müsaitlik saatleri **İstanbul saatiyle** (sabit +03:00) girilir/gösterilir.
   Kanıt yükleme: kayıt → imzalı URL'e doğrudan PUT (kimlik başlığı yok) → SHA-256 ile onay; ağ hatasında
   aynı kayıttan devam edilir. Yerelde `STORAGE_MOCK_PUBLIC_BASE_URL=/api/v1/_dev/storage` +
   `DevStorageController` (yalnız mock); bulutta bucket CORS'u Terraform `web_origins` ile (R-103).
   Açık kalanlar: R-102 (sağlayıcı hizmet adresini göremiyor), `/kimlik` ekranı (§2.1) yapılmadı —
   hazırlık listesinde kimlik durumu salt okunur. Gerçek-backend koşusunda sağlayıcı web'den başvurdu;
   onay, beceri doğrulama ve kimlik callback'i (web kapsamı dışı) betikle yapıldı.
5. `apps/admin`: tüm operasyon ekranları.
   _Uygulama notları (adım 5):_ Ayrı uygulama (`:3004`, ayrı origin), aynı-origin `/api/v1` proxy'si.
   Yazma eylemleri yalnız ADMIN'e render edilir (`ActionPanel`); SUPPORT salt okur, yetki yine
   backend'dedir. Her yazma `Idempotency-Key` taşır, otomatik tekrar yoktur. **Belirsiz hatadan**
   (ağ, 5xx, `IDEMPOTENCY_IN_PROGRESS`) sonra panel girdileri kilitlenir ve yalnız aynı gövde aynı
   anahtarla tekrar denenebilir — değiştirilmiş gerekçe yeni anahtar alıp ikinci bir iade/karar
   üretmesin diye; kesin 4xx retlerinde düzenleme serbesttir. Ham konum yanıtı cache'e/tarayıcı
   deposuna yazılmaz; `Cache-Control: no-store` `/_next/static` dışındaki her yanıtta. Girişten
   sonra derin bağlantının sorgu dizesi korunur (`safeNextPath`). Açık kalanlar: R-104 (ham konum
   gerekçesi URL'de), R-105 (admin dağıtımı Terraform'da yok, CSP `unsafe-inline`). Ödeme/iade/
   yeniden yetkilendirme ekranları yalnız **mock ödeme sağlayıcısına** karşı koşuldu: senkron dönüş,
   gerçek PSP'nin asenkron iade/webhook gecikmesi ve kısmi hata durumları sınanmadı (R-100 ile birlikte).
6. Playwright E2E (kritik akışlar), code/security/performance review, docs, faz özeti.
   _Uygulama notları (adım 6):_ `e2e/` workspace'i (ADR-0024 §7), 10 test, gerçek core API'ye
   karşı: oturum kapısı + `next` açık yönlendirme reddi; müşteri ilk giriş → rol → adres → form talebi →
   eşleşme → sağlayıcı arayüzden kabul → ödeme yetkisi (`HELD`, booking `SCHEDULED`) → başka müşteri
   randevuyu göremez; admin onayı (`Idempotency-Key` başlığı doğrulanır), SUPPORT'ta yazma düğmesi yok,
   rolsüz kullanıcı giremez; sağlayıcı taslaktan başvuruya yalnız arayüzle; kaybolan iade yanıtında
   panel kilidi + aynı anahtarla tek iade; panik (Idempotency-Key yok, risk `EMERGENCY`). Doğal dil
   yolu AI servisine bağlı olduğundan E2E'de form yolu kullanılır. E2E'nin bulduğu hata: güvenlik
   ekranı `PRE_SERVICE`'te panik butonu gösteriyordu, backend ise paniği yalnız
   `ARRIVAL_MONITORING`/`ACTIVE`'de kabul eder — artık o durumda 112 yolu gösterilir. Açık: R-106.
   _Faz sonu review (bağımsız alt ajanlar):_ yüksek/kritik bulgu yok. Düzeltilenler — web
   `Idempotency-Key` gövdeye bağlandı (kayıp yanıt + form düzeltmesi `IDEMPOTENCY_KEY_REUSED` ile
   eylemi kalıcı kilitliyordu); E2E yalnız yerel hedeflere koşar (uzak DB/Redis/API reddedilir,
   `KEYS` yerine `SCAN`); web'de `no-store`, iki uygulamada HSTS (production) + `X-Frame-Options`;
   mock giriş production build'inde derleme anında durur; `STORAGE_MOCK_PUBLIC_BASE_URL` `//host`
   kabul etmez; Firebase SDK dinamik import (mock/E2E'de indirilmez, admin'de ilk yükten ~53 KB gzip
   çıktı); katalog sorguları 1 saat taze. Kaydedilenler: R-107 (proxy hop / istemci IP), R-108
   (build'de Google Fonts), R-105 web CSP'sini de kapsar. Bilinçli bırakılanlar: müşteri randevu
   listesi sayfalanmıyor (backend 100 ile sınırlı), randevu detayında ödeme sorgusu randevuya bağlı
   (tek ek tur), güvenlik yoklaması 30 sn.

Güvenlik notları: token'lar `localStorage`'a yazılmaz (Firebase SDK persistence), CSP başlıkları, ham T.C.
kimlik girdisi web'de toplanmaz (adapter sağlayıcısının sayfasında), signed URL'ler cache'lenmez/loglanmaz.
