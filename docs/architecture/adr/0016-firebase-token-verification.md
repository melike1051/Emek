# ADR-0016 — Firebase ID Token Doğrulaması Admin SDK Yerine JWKS ile

- Durum: Accepted (2026-09-20)
- Faz: 2
- İlgili: ADR-0003 (Firestore ana DB değildir), ADR-0005 (adapter deseni)
- Blueprint: §2 (Firebase Authentication), §18

## Bağlam

Blueprint kimlik doğrulama için Firebase Authentication'ı seçiyor ve backend'in token
doğrulamasını gerektiriyor. Bunun iki yolu var:

1. **`firebase-admin` SDK** — resmî yol, `verifyIdToken()` sunar.
2. **Standart OIDC doğrulaması** — Firebase ID token'ı RS256 imzalı bir JWT'dir; Google'ın
   yayınladığı açık anahtarlarla (JWKS) doğrulanabilir. Google bunu belgeler
   ("verify ID tokens using a third-party JWT library").

Ölçüm: `firebase-admin@13` kurulumu **8 moderate güvenlik açığı** getirdi (transitif `uuid`)
ve bağımlılık ağacında `@google-cloud/firestore`, `@google-cloud/storage`, `google-gax`, gRPC
bulunuyor. Bunların hiçbirini kullanmıyoruz; Firestore ADR-0003 ile açıkça ana veri katmanı
**değil** ve depolama için imzalı URL yolu kullanılacak.

## Karar

Token doğrulaması, `TokenVerifier` portu arkasında **`jose`** ile yapılır:

- `createRemoteJWKSet()` Google'ın anahtarlarını çeker ve rotasyonu/önbelleğini yönetir.
- Doğrulanan iddialar: RS256 imza, `iss = https://securetoken.google.com/<projectId>`,
  `aud = <projectId>`, `exp`/`iat`, `sub` boş olmayan bir dize, `auth_time` mevcut.
- Sonuç, domain'e `VerifiedToken { subject, email?, phoneNumber?, emailVerified, authTime }`
  olarak döner; Firebase'e özgü hiçbir tip domain'e sızmaz.

`firebase-admin` bağımlılığı kaldırıldı. `npm audit`: **0 açık**.

## Gerekçe

- Yalnızca token doğrulaması için, kullanmadığımız (ve mimari olarak reddettiğimiz) Firestore
  ve Storage istemcilerini üretim imajına koymak hem gereksiz dependency (proje kuralı) hem de
  gereksiz saldırı yüzeyidir.
- "Kendi kriptomuzu yazmıyoruz": `jose`, JWT/JWS için yaygın kullanılan ve denetlenmiş bir
  kütüphanedir. Yaptığımız iş imza doğrulamak değil, kütüphaneye doğru iddiaları söylemektir.
- Port arkasında olduğu için gerekirse `FirebaseAdminTokenVerifier` eklemek tek dosyalık iştir.

## Sonuçlar ve sınırlar

- **Token iptali (revocation) kontrolü yoktur.** `firebase-admin`'in `checkRevoked` seçeneği
  Admin API'sine ihtiyaç duyar. Bizim modelde:
  - ID token ömrü 1 saattir; iptal en kötü durumda bu süre kadar gecikir.
  - Acil oturum sonlandırma gerekirse Redis tabanlı bir denylist (subject bazlı) eklenir —
    Faz 12 güvenlik sertleştirmesinde değerlendirilir. `TODO(security)` olarak işaretlidir.
- **Kullanıcı yönetimi (custom claims, kullanıcı silme) backend'den yapılamaz.** Faz 2'de
  ihtiyaç yok; roller Emek veritabanında (`user_roles`) tutulur, token'da değil. Bu zaten
  tercih edilen tasarım: yetki kaynağı tek yerde (RBAC, ADR-0013).
- **FCM ve App Check** ilgili fazda (16 / 12) ayrı ve hafif istemcilerle bağlanır; Admin SDK'yı
  geri getirmek için gerekçe oluşursa bu ADR gözden geçirilir.
- Yerel geliştirme ve testler için `MockTokenVerifier` vardır; `AUTH_PROVIDER=mock`
  production ile birlikte verilirse servis **başlamaz** (ADR-0005/0009 ile aynı kural).

## Alternatifler

- **`firebase-admin` (reddedildi):** kullanılmayan büyük bağımlılık ağacı, açık gürültüsü,
  mimari olarak reddedilen Firestore istemcisi.
- **Kendi JWT/imza doğrulama kodumuz (reddedildi):** güvenlik kritik kodu elle yazmak.
- **Session cookie tabanlı akış (ertelendi):** Admin SDK gerektirir; mobil istemci için
  bearer token modeli yeterli.
