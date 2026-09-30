# Emek mobil (Flutter)

Müşteri + sağlayıcı uygulaması (Faz 16, ADR-0025, `docs/architecture/phase-16-plan.md`).
Kurulum ve komutlar: `docs/architecture/local-development.md` §Mobil uygulama.

```bash
flutter pub get
flutter analyze && flutter test                     # altyapı gerekmez
flutter run --dart-define=AUTH_MODE=mock --dart-define=API_BASE_URL=http://localhost:3000
flutter test integration_test -d <simülatör>        # gerçek yerel core API ister
```

Android emülatöründe API adresi `http://10.0.2.2:3000`'dir.
