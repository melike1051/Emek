# Faz 16 — Flutter Mobile: Plan

Durum: **⚠️ kod tamam, yalnız yerel doğrulandı (2026-09-30).** Push bu fazda yapıldı (§3 seçeneği). ✅ Adım 1 · ✅ Adım 2 · ✅ Adım 3 · ✅ Adım 4 · ✅ Adım 5 · ✅ Adım 6. Gerçek Firebase/APNs, Android cihaz/emülatör ve mağaza dağıtımı doğrulanmadı (R-110, R-111, R-112, R-84).

Girdiler: `docs/architecture/phase-plan.md` §Faz 16 (onboarding, identity, booking, matching, payment,
service session, safety, reviews, profile, notifications), Faz 15 ekran envanteri
(`phase-15-plan.md` §2 — mobil aynı backend yeteneklerini kullanır), ADR-0022 (App Check mobil
istemciyle gerçek zorunluluk olur), ADR-0019 (safety), ADR-0008 §3 (panik).

Web'den farkı: mobil **sağlayıcının telefonudur**. Web'in bilerek yapmadığı iki iş burada yapılır:
hizmet oturumu telemetrisi (`POST /safety/sessions/{id}/telemetry`) ve push bildirimi.

## 1. Mimari kararlar (ADR-0025 olarak yazılacak)

| Konu           | Karar (öneri)                                                                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uygulama       | Tek Flutter uygulaması `apps/mobile` (müşteri + sağlayıcı, web'deki gibi tek oturum + rol bağlamı). iOS + Android. Web/desktop hedefi yok.                                                                                                      |
| Durum/rota     | `flutter_riverpod` (durum + DI) + `go_router` (derin bağlantı, oturum yönlendirmesi). Başka mimari katmanı (bloc, clean-architecture iskeleti) eklenmez.                                                                                        |
| API istemci    | `http` üzerine ince tipli istemci; modeller elle, kaynak DTO'ya işaret ederek (ADR-0024 ile aynı gerekçe: OpenAPI şemaları boş — R-99). Kritik mutasyonlar `Idempotency-Key` taşır, anahtar **gövdeye bağlı** (ADR-0024 Sonuçlar).              |
| Auth           | `firebase_auth` telefon OTP → ID token → `POST /auth/session`. Yerel geliştirmede `AUTH_PROVIDER=mock` için `--dart-define=AUTH_MODE=mock` geliştirici girişi; release build'de derlenmez/reddedilir.                                           |
| App Check      | `firebase_app_check`: Android Play Integrity, iOS App Attest (DeviceCheck yedeği). `X-Firebase-AppCheck` başlığı. Debug provider yalnız debug build.                                                                                            |
| Telemetri      | Yalnız aktif oturumda (`ARRIVAL_MONITORING`/`ACTIVE`), yalnız sağlayıcı cihazından. `geolocator`: Android foreground service + kalıcı bildirim; iOS "When In Use" + background location modu **oturum süresince**. Oturum kapanınca akış durur. |
| İstemci güveni | Monoton `sequence` cihazda kalıcı (oturum başına), `capturedAt` cihaz saati (sunucu zamanı yetkilidir), Android `isMocked` → `isMockLocation`. Gönderilemeyen örnekler sırayla tamponlanır, yeniden sıralanmaz.                                 |
| Kanıt          | `image_picker` → SHA-256 (cihazda) → imzalı URL'e PUT → onay (web ile aynı akış).                                                                                                                                                               |
| Kimlik         | Ham T.C. kimlik numarası uygulamada **toplanmaz/okunmaz**. Doğrulama sağlayıcısının sayfası sistem tarayıcısında açılır, dönüş derin bağlantıyla; NFC okuma sağlayıcının SDK/sayfasının işidir (adapter sınırı).                                |
| Push           | `firebase_messaging`. **Backend boşluğu** (§3): cihaz token kaydı + teslimat worker'ı yok (R-77).                                                                                                                                               |
| Depolama       | Token'lar Firebase SDK'da; uygulama kendi sırrını saklamaz. Hassas veri (adres, konum) diske önbelleklenmez. Mock token yalnız bellekte.                                                                                                        |
| Dil            | Arayüz Türkçe, tek dil (web ile aynı karar).                                                                                                                                                                                                    |
| Test           | `flutter_test` (widget + birim, HTTP sahte istemciyle), telemetri tamponu/sıra numarası için saf Dart testleri, `integration_test` ile simülatörde kritik akış (mock auth + gerçek yerel API). `flutter analyze` sıfır uyarı.                   |

## 2. Ekran envanteri

Web envanterinin mobil karşılığı (`phase-15-plan.md` §2.1–2.3); admin ekranları mobilde **yoktur**.

| Alan      | Ekranlar                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ortak     | Giriş (OTP / dev), rol seçimi, hesap + adresler, kimlik doğrulama başlat/durum                                                                                         |
| Müşteri   | Keşfet & talep (doğal dil + form), talep özeti, eşleşme + gerekçeler, randevular, randevu detayı (ödeme, onay, değerlendirme, itiraz, iptal), kanıtlar, güvenlik/panik |
| Sağlayıcı | Panel + hazırlık, profil, hizmet/beceri, bölgeler (konumdan seç), müsaitlik, randevular + geçişler, kanıt yükleme (kamera), **hizmet oturumu (telemetri + panik)**     |

## 3. Backend boşlukları

1. **Cihaz token kaydı** — `POST/DELETE /users/me/devices` (FCM token, platform), `users` ile 1-N, hesap
   kapatmada silinir (retention envanterine eklenir). Yeni migration + RBAC matrisi.
2. **Push teslimatı (R-77)** — `notification_jobs` `PENDING` işlerini tüketen worker + FCM adapter
   (mock/gerçek, adapter arkasında). Payload'da PII yok, yalnız kimlik + tür.
3. **Kimlik dönüş URL'i** — doğrulama oturumunun mobil derin bağlantıya dönmesi için izinli dönüş
   şeması (allowlist; açık yönlendirme yok). Mevcut `POST /verification/session` sözleşmesi incelenecek.

Seçenek: 1–2 bu fazda yapılır **veya** push Faz 17'ye bırakılıp mobilde yalnız uygulama içi yenileme
kalır. Öneri: bu fazda yapılır — faz kapsamı "notifications" diyor ve R-77 açık kalırsa panik/eşleşme
bildirimleri hiçbir istemciye ulaşmaz.

## 4. Uygulama sırası (alt adımlar)

1. ADR-0025 + `apps/mobile` iskeleti: proje, analiz kuralları, tema (Stitch token'ları), API istemcisi,
   auth (mock + Firebase), oturum yönlendirmesi, CI (`flutter analyze` + `flutter test`).
   _Uygulama notları (adım 1):_ ADR-0025. `apps/mobile`: `AppEnv` (`--dart-define`; release mock'u ve
   http'yi reddeder), `ApiClient` (hata sözleşmesi, App Check başlığı, zaman aşımı → ağ hatası),
   gövdeye bağlı `IdempotencyKey`, mock + Firebase auth adapter'ı (App Check: Play Integrity / App
   Attest), `sessionRedirect` (saf, testli), giriş + rol seçimi + iki ana sayfa kabuğu, Emek teması.
   CI'da `dart format`, `flutter analyze` (strict-casts/inference/raw-types), `flutter test`. Simülatör
   testi (iPhone 17 Pro) gerçek yerel API'ye karşı geçti: giriş → rol seçimi → profil → çıkış →
   aynı kimlikle yeniden giriş. Rol seçimi ekranı profil oluşunca kendisi yönlendirir (web ile
   aynı: `/rol-sec` ikinci profil için de kullanılır, router orada kalmaya izin verir).
2. Müşteri akışı: talep → eşleşme → randevu → ödeme → onay/değerlendirme/itiraz → güvenlik/panik.
   _Uygulama notları (adım 2):_ Keşfet (adres + doğal dil + netleştirme; AI kapalıysa form), talep
   özeti (düşük güven uyarısı, "düzelt" yeni talep açar), eşleşme sonucu (kapalı kod → Türkçe
   gerekçe), randevular, randevu detayı (ödeme, hizmet onayı, değerlendirme, itiraz, iptal, zaman
   çizelgesi), güvenlik (30 sn yoklama; panik yalnız `ARRIVAL_MONITORING`/`ACTIVE`'de, anahtarsız;
   aksi hâlde 112 araması). Kurallar `lib/domain/booking_rules.dart`'ta web ile aynı ve testli.
   Riverpod 3'ün varsayılan "her hatayı tekrar dene" davranışı kapatıldı: yalnız ağ/429/503, en çok
   2 kez (web `shouldRetry`). Bulunan hatalar: kısa içerikte aşağı çekerek yenileme çalışmıyordu
   (`AlwaysScrollableScrollPhysics`); Dart `toUpperCase` Türkçe değil (`trUpper`: "GÜVENLİK").
   Simülatörde gerçek core API + AI servisi + seed'li sağlayıcıya karşı uçtan uca geçti: doğal dil
   (`heuristic-v1`, güven 0,759) → gerçek motor (`matching-v1`, 6 gerekçe) → sağlayıcı onayı →
   çekerek yenileme → ödeme `HELD`. Adres koordinatı hâlâ elle girilir (R-101); cihaz konumu adım 4.
   Adım 3'te bulunan eksik: müşteri randevu listesi sağlayıcı olarak verilen işleri de gösteriyordu
   (web yalnız `customerId == userId`); düzeltildi, testli.
3. Sağlayıcı akışı: profil/başvuru, hizmet/bölge/müsaitlik, randevu geçişleri, kamera ile kanıt.
   _Uygulama notları (adım 3):_ Panel (durum, hazırlık listesi — kimlik başvuruyu bloklamaz —,
   başvuru, sıradaki işler), profil, hizmet/beceri, bölge (kayıtlı adresten merkez), haftalık
   müsaitlik (İstanbul saati), randevular (yalnız `providerId == userId`), randevu detayı: kabul /
   gerekçeli ret (`cancel`), hizmet günü adımları (her adım iki aşamalı, gövdeye bağlı anahtar),
   iptal, kanıt: kamera/galeri → JPEG (`imageQuality`, iOS HEIC reddedilir) → kayıt → imzalı URL'e
   kimliksiz PUT (göreli mock URL API köküne çözülür) → SHA-256 onay; yükleme ağda kalırsa **aynı
   kayıttan** devam. Güvenlik ekranı sağlayıcı bakışıyla paylaşılır. Simülatörde gerçek backend'e
   karşı: kabul → müşteri öder → yola çık → var → "önce" fotoğrafı (`AVAILABLE`, sunucu SHA-256'sı) →
   başlat. Açık: R-109 (EXIF konumu). Müsaitlik girişi yerel saat seçicisiyle olduğundan simülatör
   testine alınmadı; widget testleriyle sınandı.
4. Hizmet oturumu telemetrisi: izinler, foreground service / background modu, tampon + sıra numarası,
   mock-location, pil/aralık (`telemetryIntervalSeconds`'a uyum), oturum kapanınca durma.
   _Uygulama notları (adım 4):_ `lib/telemetry/`: saf `TelemetryBuffer` (sıra sunucunun
   `lastSequence` değerinden sürer — cihazda kalıcı depo yok; aralık ≥ 5 sn; parti ≤ 20; 900 sn'den
   eski örnek atılır), `TelemetryEngine` (sunucunun işlediği her örnek — kabul ya da ret — bırakılır;
   ağ/5xx/401'de aynı numaralarla tekrar; kalıcı sözleşme hatasında parti bırakılır; oturum kabul
   etmeyi bırakınca kendini durdurur, önce konum donanımı), `GeolocatorSource` (Android ön plan
   servisi + kalıcı bildirim, iOS oturum süresince arka plan modu + sistem göstergesi; **"her
   zaman" izni ve `ACCESS_BACKGROUND_LOCATION` yok**), `TelemetryController` (tek kural:
   `telemetryExpectedFromYou`; eşzamanlı eşitlemeler sıraya alınır; çıkışta durur). Otomatik
   başlatma **uygulama kökünde**: Riverpod 3 görünmeyen widget'ların izlediği sağlayıcıları
   duraklatır — kabukta kalsaydı "hizmet bitti" geçişi telemetriyi ayrıntı ekranındayken
   durdurmazdı (widget testi yakaladı). Adres ve bölge formlarına "Konumumu kullan" (yalnız
   dokununca, tek okuma). Simülatörde gerçek konum kaynağı + gerçek API: yola çıkınca sıra 1
   simüle konumda kaydedildi (`INSIDE`, 0 m, doğruluk 5 m) ve iOS'un "yazılımla simüle" işareti
   `is_mock_location = true` olarak uçtan uca taşındı. Doğrulanmayan: Android'de ön plan servisi
   (emülatör yok — yalnız derleme), gerçek cihazda arka plan süresi ve pil (R-110).
5. Backend boşlukları (§3) + push + App Check (Play Integrity / App Attest) + kimlik derin bağlantısı.
   _Uygulama notları (adım 5):_ Backend: `user_devices` (token cihaza aittir — başka hesapla
   gelince taşınır; yanıtta dönmez), `POST/DELETE /users/me/devices`, `NotificationDeliveryWorker`
   (kira ile sahiplenme — iki instance aynı işi göndermez; cihaz yoksa `NO_DEVICE`; randevu durumu geçmişse `STALE` (R-114); SMS/e-posta kanalı mock ile, iletişim bilgisi gönderim anında okunur; geçersiz token
   silinir; üstel geri çekilme), `PushSender` (mock / FCM HTTP v1, ADC; dağıtılan ortamda `fcm`
   zorunlu), Terraform: `fcm.googleapis.com` + `roles/firebasecloudmessaging.admin`. **R-76
   düzeltildi:** alıcı consumer transaction'ında rezervasyondan; `SafetyAlertRaised` ve
   `BookingCreated` taraflara bildirilmez. Retention: 90 gün görülmeyen token + anonimleştirmede
   silme. Mobil: `PushRegistrar` (oturumla kayıt, token yenilemede tekrar, çıkışta **önce**
   kayıt silme), dokunmada yalnız izin listesindeki randevu rotası açılır. Bulunan güvenlik
   hatası: kimlik doğrulama oturumu audit'e `request.ip` yazıyordu (R-53 ihlali, Cloud Run
   arkasında herkes aynı IP) — `resolveClientIp`'e çevrildi, testli; semgrep kuralı yalnız oran
   sınırı dizinini taradığı için kaçmıştı, kapsam tüm core API'ye genişletildi. Kimlik başlatma
   mobilde yok (R-111); iOS push APNs'e bağlı (R-112). App Check sağlayıcıları (Play Integrity /
   App Attest) kodda; gerçek Firebase projesiyle doğrulanmadı.
6. Simülatörde entegrasyon testleri, code/security/performance review, docs, faz özeti.
   _Uygulama notları (adım 6):_ Dört simülatör testi (iPhone 17 Pro, iOS 26.4) gerçek yerel core
   API + AI servisine karşı geçti: giriş/rol seçimi, müşteri akışı (doğal dil → eşleşme → onay),
   sağlayıcı akışı (kabul → yola çık → var → kanıt → başlat), gerçek konum kaynağıyla telemetri.
   Koşu notları: (1) önceden ayakta olan, izlemesiz başlatılmış bir API eski kodla çalışıyordu —
   testler taze bir instance'a (`api-verify`, 3006) karşı koşturuldu; (2) `flutter test`
   uygulamayı yeniden kurduğu için konum izni kurulumdan **sonra** verilmeli (test sürerken
   `simctl privacy grant`); (3) boşluk içeren seed değerleri `--dart-define`'a dizi olarak
   geçirilmeli. Bağımsız code, security ve performance review'ları (üç ayrı ajan) sonrası
   düzeltilenler: teslimat worker'ı kira aşımında çift gönderim yapabiliyordu (sıralı döngü, 50
   iş × cihaz × 10 sn) — iş eşzamanlılığı 10, cihazlara paralel gönderim, sonuç yazımı kiraya
   bağlı (`next_attempt_at = kira`, metin olarak — JS `Date` mikrosaniyeyi keser), cihaz sorgusu
   tur başına tek; kullanıcı başına 10 cihaz üst sınırı + kayıt ucuna kullanıcı kotası; geçersiz
   token silme token + sahip ile (bu arada taşınan kaydı silmez); FCM `INVALID_ARGUMENT` artık
   token hatası değil (bozuk yük tüm cihaz kayıtlarını silerdi); operatör yeniden denemesi deneme
   sayacını sıfırlar; bekleyen iş indeksi yalnız `PUSH`, R-76 öncesi teslim edilemez işler
   `LEGACY_R76` ile kapatılır; şablon bozuk randevu kimliğiyle rota üretmez. Mobil: kayıt yanıtı
   gelmeden çıkış yapılınca cihaz çıkış yapan hesaba kayıtlı kalıyordu — çıkış süren kaydı
   bekler, eski kayıt yeni abonelik kurmaz; güvenlik ekranı yoklaması arka planda durur; release
   Android manifest'inde `INTERNET` izni yoktu. Simülatör koşusunda ayrıca bulunan (Faz 2'den
   kalma) hata: başka hesaba bağlı telefonla yeni kimlik `uq_users_phone` ihlaliyle 500
   dönüyordu — artık `409 AUTH_CONTACT_IN_USE`, hesaplar birleştirilmez. Ertelenen: R-113
   (oturum ortası aralık değişimi), R-114 (bayat bildirim).

## 5. Kapsam dışı / riskler

- Mağaza yayını, imzalama, gerçek cihaz dağıtımı (Faz 17).
- Gerçek Firebase projesi/App Check anahtarları yok → yerelde mock auth + App Check kapalı
  (`APP_CHECK_ENABLED=false`); gerçek sağlayıcılarla doğrulama dağıtım ortamını bekler.
- iOS arka plan konumu App Store incelemesinde gerekçe ister — `TODO(legal)`: KVKK aydınlatma metni
  ve konum izni açıklama metinleri.
- Yerel ortam: iOS 27 simülatör çalışma zamanı kurulu değil (`flutter doctor`), iOS 26.4 simülatörü
  mevcut; Android emülatörü kontrol edilecek.
