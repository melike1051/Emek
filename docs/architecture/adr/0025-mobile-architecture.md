# ADR-0025 — Mobil (Flutter) mimarisi

Durum: kabul edildi (Faz 16)
İlgili: ADR-0016 (Firebase Auth), ADR-0019 (safety), ADR-0022 (App Check), ADR-0024 (web),
ADR-0008 §3 (panik), [phase-16-plan.md](../phase-16-plan.md)

## Bağlam

Web (ADR-0024) müşteri, sağlayıcı ve operasyon yüzeylerini kapsıyor ama iki işi bilerek yapmıyor:
hizmet oturumu telemetrisi (sağlayıcının konumu yalnız aktif oturumda) ve push bildirimi. İkisi de
sağlayıcının telefonunu gerektirir. App Check zorunluluğu da (ADR-0022) gerçek anlamını ancak mobil
istemciyle kazanır: tarayıcıda reCAPTCHA sinyali zayıftır, Play Integrity / App Attest cihaz bütünlüğü
kanıtlar.

## Karar

1. **Tek uygulama** `apps/mobile` (Flutter, iOS + Android): müşteri + sağlayıcı, tek oturum, rol
   bağlamı (web ile aynı model). Operasyon ekranları mobilde yoktur.
2. **Durum ve rota:** `flutter_riverpod` (durum + bağımlılık enjeksiyonu), `go_router`. Oturum
   yönlendirmesi saf bir fonksiyondur (`sessionRedirect`) ve birim testlidir. Ek mimari katman
   (bloc, clean-architecture iskeleti) yoktur.
3. **API istemcisi:** `http` üzerine ince istemci; modeller elle, kaynak DTO'ya işaret ederek (R-99:
   OpenAPI şemaları boş). Hata sözleşmesi web ile aynıdır (`ApiError`, güvenli `message`,
   `requestId`). Mobil API'ye **doğrudan** konuşur — web'deki aynı-origin proxy yoktur (R-107).
4. **Idempotency:** `IdempotencyKey` gövdeye bağlıdır — aynı gövdenin tekrarı aynı anahtarı,
   değişen gövde yeni anahtarı taşır (ADR-0024 Sonuçlar). Anahtar yalnız bellektedir.
5. **Auth:** Firebase telefon OTP → ID token → `POST /auth/session`. Yerelde
   `--dart-define=AUTH_MODE=mock` (backend `AUTH_PROVIDER=mock`) geliştirici girişi; token yalnız
   bellekte. `AppEnv.parse` release build'de mock'u ve `https` olmayan API adresini reddeder.
6. **App Check:** `firebase_app_check` — Android Play Integrity, iOS App Attest (DeviceCheck yedeği);
   debug sağlayıcısı yalnız debug build. Başlık `X-Firebase-AppCheck`.
7. **Yapılandırma:** yalnız `--dart-define`. Firebase seçenekleri de buradan gelir;
   `google-services.json` / `GoogleService-Info.plist` repoya girmez.
8. **Telemetri (adım 4):** yalnız aktif oturumda ve yalnız sağlayıcı cihazından; oturum başına
   monoton `sequence`, sunucu zamanı yetkili, `isMockLocation` kayda geçer. Konum diske
   önbelleklenmez.
9. **Kimlik:** ham T.C. kimlik numarası uygulamada toplanmaz/okunmaz; doğrulama sağlayıcısının
   sayfası sistem tarayıcısında açılır (adapter sınırı).
10. **Test:** `flutter test` (birim + widget, sahte `http` istemcisi) CI'da; `integration_test`
    simülatörde gerçek yerel core API'ye karşı, elle (R-106).

## Sonuçlar

- Yerelde düz http yalnız yerel adreslere açıktır: iOS `NSAllowsLocalNetworking`, Android debug
  manifest'inde `10.0.2.2`/`localhost` için `network_security_config`. Release https ister.
- Asgari iOS 15 (Firebase). Yazı tipleri henüz paketlenmedi — sistem yazı tipi (R-108 ile birlikte
  ele alınır); renkler `packages/ui` token'larıyla aynıdır.
- Xcode 27'nin `lipo -verify_arch` çoklu mimari sözdizimi Flutter 3.41.7'nin
  `flutter build ios --simulator` adımını kırıyor; `flutter run` / `flutter test integration_test`
  (yalnız etkin mimari) çalışıyor. SDK yamalanmadı; Flutter güncellemesiyle kapanması beklenir.
- Telemetri denetleyicisi ekranlardan bağımsız yaşar ve **uygulama kökünden** eşitlenir: Riverpod 3
  görünmeyen widget'ların izlediği sağlayıcıları duraklatır; oturumun yaşam döngüsü görünür ekrana
  bağlanmamalıdır. Asenkron sağlayıcılar her beklemeden sonra `ref.mounted` denetler.
- Telemetri sırası cihazda saklanmaz: sunucu oturum görünümünde `lastSequence` verir; uygulama
  yeniden açılınca numaralandırma oradan sürer. Gönderilemeyen örnekler yalnız bellektedir
  (uygulama öldürülürse kaybolur — boşluk sunucuda "sessizlik" olarak görünür, bu kabul edilen
  davranıştır).
