# ADR-0024 — Web frontend mimarisi

Durum: kabul edildi (Faz 15)
İlgili: ADR-0015 (TypeScript/modül sistemi), ADR-0016 (Firebase Auth), ADR-0022 (güvenlik, App Check),
[phase-15-plan.md](../phase-15-plan.md)

## Bağlam

Faz 15'e kadar hiçbir istemci yoktu. Backend ≈100 uçlu bir OpenAPI sözleşmesi üretiyor; Google Stitch
paketi (`DESIGN.md` "Artisanal Trust & Local Labor") görsel dili tanımlıyor ama site haritası değil.
Üç kullanıcı yüzeyi (müşteri, sağlayıcı, operasyon) aynı görsel dili paylaşmak zorunda.

## Karar

1. **İki Next.js (App Router) uygulaması.** `apps/web` müşteri + sağlayıcı yüzeyini taşır (1 insan =
   1 `users` kaydı; aynı oturumda iki profil). `apps/admin` yalnızca `ADMIN`/`SUPPORT` içindir — ayrı
   dağıtım birimi, ayrı origin, ayrı saldırı yüzeyi. `apps/web`'de admin rotası bulunmaz.
2. **`packages/ui`** — tasarım token'ları (CSS custom properties) ve temel React bileşenleri. Stil
   CSS Modules ile; Tailwind/CSS-in-JS runtime'ı eklenmez. Stitch HTML'i kopyalanmaz, token'ları alınır.
3. **`packages/api-client`** — elle yazılmış istek/yanıt tipleri (her biri kaynak DTO'yu yorumda
   gösterir) + tipli `fetch` istemcisi: tek hata tipi (`ApiError`, backend `{ error: { code, message, requestId } }`
   biçimi), yan etkili çağrılarda `Idempotency-Key`, `Authorization: Bearer`, `X-Firebase-AppCheck`.
4. **Kaynak olarak paylaşım.** Paketler derlenmez; Next.js `transpilePackages` ile tüketir. (Backend'in
   `tsc` kısıtı — CLAUDE.md §4 Faz 9 notu — burada geçerli değildir; `services/api` bu paketleri import etmez.)
5. **Aynı-origin proxy.** Tarayıcı yalnızca kendi origin'indeki `/api/v1/*`'e konuşur; Next.js `rewrites`
   bunu `API_ORIGIN`'e iletir. Backend'de CORS açılmaz. Proxy hop'u `TRUSTED_PROXY_HOP_COUNT` hesabına
   dahil edilir (R-53) — dağıtımda doğrulanacak. Proxy bir hop eklediği için tek hop sayısı
   hem tarayıcı hem mobil yoluna doğru olamaz: R-107.
   **İstisna — kanıt dosyası:** dosya API'den geçmez (ADR-0003); tarayıcı imzalı URL'e doğrudan PUT/GET
   yapar. Bu yüzden CSP `connect-src` `storage.googleapis.com`'u içerir ve bucket CORS'u yalnızca web
   origin'lerine, yalnızca PUT/GET için açılır (Terraform `web_origins`). İmza yetkidir; bu istek kimlik
   veya App Check başlığı taşımaz. Yerelde mock storage aynı-origin `/api/v1/_dev/storage`'dır (R-103).
6. **Auth.** Firebase Web SDK (telefon OTP) → ID token → `POST /auth/session`. Token SDK'nın kendi
   kalıcılığında kalır, uygulama `localStorage`'a yazmaz. Yerelde `AUTH_PROVIDER=mock` için
   `mock:<subject>` token'lı geliştirici girişi yalnızca `NODE_ENV=development` build'inde derlenir.
7. **Veri çekme:** TanStack Query. **Test:** Vitest + Testing Library; kritik akışlar Playwright.
   E2E iki uygulamayı ve gerçek core API'yi birlikte sürdüğü için hiçbir uygulamaya ait değildir:
   kök `e2e/` workspace'i (`@emek/e2e`) — repo yapısına bu ADR ile eklenir. Sınanan akış her zaman
   arayüzden geçer; başka aktörün kararı olan ön koşullar (sağlayıcı onayı, kimlik callback'i,
   operatör rolü) API + SQL ile kurulur.

## Sonuçlar

- OpenAPI sözleşmesi **yalnızca rota listesidir**: 31 DTO şemasının hiçbiri alan taşımıyor
  (`properties: {}`) ve hiçbir yanıt gövdesi tanımlı değil. Neden: build `tsc` iledir (ADR-0015),
  `@nestjs/swagger` CLI eklentisi çalışmaz ve DTO'larda `@ApiProperty` yok. Bu yüzden tip üretimi
  (`openapi-typescript`) denendi ve **kaldırıldı** — boş şemadan üretilen tipler güvenlik hissi verip
  hiçbir şey denetlemiyordu. İstek ve yanıt tipleri `packages/api-client/src/resources/*` altında elle,
  kaynak DTO'ya işaret ederek yazılır — sürüklenme riski R-99.
- Tasarımda olup API'de olmayan yüzeyler (sağlayıcı keşif listesi, bildirimler, cüzdan) Faz 15'te
  uydurulmaz; keşif talep-odaklıdır (seçim zinciri, CLAUDE.md §4 AI).
- Operasyon yazma eylemleri tek bir desenden geçer (`apps/admin` `ActionPanel`): gerekçe/çift onay,
  gövde başına `Idempotency-Key`, otomatik tekrar yok. Sunucunun isteği işleyip işlemediği
  bilinmiyorsa (ağ, 5xx, `IDEMPOTENCY_IN_PROGRESS`) girdiler kilitlenir; gövde değiştirilip yeni
  anahtarla gönderilemez — aksi hâlde kayıp yanıt sonrası düzeltilmiş gerekçe ikinci iadeyi tetikler.
- Web komutlarında `Idempotency-Key` **gövdeye bağlıdır** (`useIdempotencyKey().current(signature)`):
  aynı gövdenin tekrarı aynı anahtarı, değişmiş gövde yeni anahtarı taşır. Backend gövde parmak izi
  uyuşmayan anahtarı `IDEMPOTENCY_KEY_REUSED` ile kalıcı reddettiği için, kayıp yanıttan sonra
  formu düzelten kullanıcı aksi hâlde eylemi tamamlayamazdı. Admin tarafında aynı durum girdilerin
  kilitlenmesiyle çözülür (para hareketi — düzeltilmiş gövde ikinci iade olmamalı).
- Firebase SDK'sı dinamik import ile yalnız firebase modunda yüklenir; mock build'e girmez.
  `NEXT_PUBLIC_AUTH_MODE=mock` ile production build `next.config.ts`'te derleme anında durur.

## Ek — Faz 17 (R-105)

- **CSP nonce'ludur.** `script-src 'self' 'nonce-…' 'strict-dynamic'`; `'unsafe-inline'` yoktur
  (`src/lib/csp.ts`, `src/proxy.ts`). Nonce istek başına üretilir; bu yüzden tüm sayfalar dinamik
  render edilir (kök layout `connection()` bekler) — statik önbellekleme bilinçli olarak bırakıldı.
  `style-src 'unsafe-inline'` kalır (satır içi `style` öznitelikleri). E2E (`*.csp.spec.ts`):
  her SSR script'i aynı nonce'u taşır, CSP ihlali olmaz, nonce her istekte değişir.
- **Dağıtım:** `infra/docker/Dockerfile.frontend` (Next `standalone`), Terraform `frontend.tf`:
  web herkese açık; admin **Cloud Run doğrudan IAP** arkasında (`allUsers` yok, yalnız IAP servis
  ajanı invoker, `admin_access_members` erişir). İmajlar ortama özeldir (`NEXT_PUBLIC_*`).
