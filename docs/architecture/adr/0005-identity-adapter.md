# ADR-0005 — Identity Verification Adapter Layer

- Durum: Accepted (2026-09-20)
- Faz: 3
- Blueprint: §2, §10, §29

## Bağlam

Kimlik doğrulama için NFC/e-ID, EKDS/KDHS erişimi veya ticari KYC sağlayıcıları söz konusu.
**EKDS veya resmî servislere erişimin hazır, garantili bir API olduğu varsayılamaz**; erişim modeli
kurumsal izin, sözleşme ve hukuki doğrulama gerektirir (bkz. `docs/research/technical-risks.md` R-01).
Sağlayıcı seçimi proje ömrü boyunca değişebilir.

## Karar

Core backend somut bir sağlayıcıyı **tanımaz**. Bir port/adapter katmanı tanımlanır:

```
IdentityVerificationProvider (port)
  startSession(userRef, method, purpose)  -> { externalSessionId, clientToken, expiresAt }
  getSessionResult(externalSessionId)     -> VerificationResult
  handleCallback(signedPayload)           -> VerificationResult   // imza doğrulaması adapter'da
  capabilities()                          -> { methods, livenessSupported, assuranceLevel,
                                               producesDeterministicIdentityHash: boolean }

VerificationResult
  status: PENDING | VERIFIED | REJECTED | EXPIRED
  verificationLevel
  providerSubjectId            // ham kimlik verisi DEĞİL
  identityHash                 // adapter içinde KMS HMAC ile üretilir; ham girdi dışarı çıkmaz
  assuranceLevel               // NFC-only ile liveness'lı doğrulama ayrımı
  verifiedAt
  resultCode
```

Adapter implementasyonları: `MockIdentityProvider` (Faz 3, deterministik, test ve demo için),
ardından gerçek sağlayıcı(lar). Domain katmanı yalnızca port'u bilir.

Ek kurallar:

- Adapter'dan çıkan ham kimlik alanları (isim, TCKN, doğum tarihi, belge görüntüsü) core domain'e
  **geçirilmez**; adapter sınırında normalize edilip atılır. Core yalnızca referans + seviye + sonuç görür.
- `identity_hash` (ADR-0004) **adapter sınırının içinde** üretilir — ham kimlik verisini gören tek
  bileşen burasıdır. Adapter, Cloud KMS'teki non-exportable HMAC anahtarıyla hash'i hesaplayıp
  `VerificationResult` içinde yalnızca hash'i döner. Bir adapter deterministik hash üretemiyorsa
  `capabilities()` bunu bildirir ve o sağlayıcı tekillik gerektiren akışlarda tek başına kullanılamaz.
- `verification_attempts` her denemeyi kaydeder (sağlayıcı, method, external session, sonuç kodu).
  Başarısız denemeler oran sınırına tabidir.
- `assuranceLevel` saklanır: NFC tek başına "telefonu tutan = kart sahibi" **kanıtı değildir**.
  Yüksek güven gerektiren akışlar (provider onayı, recovery) minimum assurance seviyesi talep eder.
- Callback endpoint'i imza doğrular, idempotenttir ve replay'e karşı korunur.

## Gerekçe

Sağlayıcı değiştiğinde 18 modül değişmemeli. Mock adapter, gerçek sağlayıcı sözleşmesi
tamamlanmadan Faz 4-8'in geliştirilip test edilmesini sağlar — TÜBİTAK takvimindeki en büyük
dış bağımlılık riskini izole eder.

## Sonuçlar

- Mock adapter'ın production'da devre dışı olduğu config ile garanti edilir ve test edilir
  (production'da mock provider seçilirse servis **başlamaz**).
- Sağlayıcı yetenek farkları `capabilities()` üzerinden yönetilir; kod dallanması domain'e sızmaz.
- Biyometrik/liveness devreye girerse KVKK özel nitelikli veri kuralları uygulanır — `TODO(legal)`.

## Uygulama notu (Faz 3)

- Port uygulandı: `IdentityVerificationProvider` (+ `capabilities()`), `MockIdentityProvider`.
  Domain katmanı yalnızca portu bilir; `IDENTITY_PROVIDER=mock` production'da reddedilir.
- **Ham kimlik verisi adapter içinde kalır:** mock adapter `nationalId`'yi alır, KMS anahtarlı
  HMAC'e çevirir ve atar. `VerificationResult` yalnızca referans + hash + güvence seviyesi
  taşır. Bir integration testi tüm tabloları, audit'i ve event'leri tarayarak ham değerin
  hiçbir yerde olmadığını doğrular.
- **Callback imzası adapter'ın içindedir** ve **ham gövde** üzerinden doğrulanır (JSON'u yeniden
  serileştirmek imzayı bozar; bu yüzden Nest `rawBody: true` ile kurulur). İmzasız, yanlış
  imzalı ve gövdesi değiştirilmiş çağrılar aynı hata koduyla reddedilir — hangi kontrolün
  başarısız olduğu sızdırılmaz.
- **Hash anahtarı kaynağı da porttur:** yerelde ortam değişkeni, production'da KMS. KMS adapter'ı
  Faz 13'te bağlanacak ve o ana kadar açıkça hata verir; sessizce zayıf anahtara düşmez (R-39).

## Alternatifler

- **Doğrudan EKDS entegrasyonu (reddedildi):** erişim garanti değil, tek noktaya bağımlılık.
- **Tek ticari KYC sağlayıcısına gömülü entegrasyon (reddedildi):** sözleşme/fiyat değişiminde kilitlenme.
