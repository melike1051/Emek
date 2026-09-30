# ADR-0026 — Web proxy'si üzerinden istemci adresi

Durum: kabul edildi (Faz 17)
İlgili: ADR-0022 §2 (proxy güveni, R-53), ADR-0024 §5 (aynı-origin proxy), ADR-0025 §3, R-107

## Bağlam

Core API istemci adresini `resolveClientIp(request, TRUSTED_PROXY_HOP_COUNT)` ile çözer: zincir
sağdan okunur, güvenilen hop kadar atlanır (R-53). İki trafik yolu vardır:

- **Mobil** API'ye doğrudan gelir: `istemci → Cloud Run ön ucu → API`.
- **Web/admin tarayıcısı** Next.js aynı-origin proxy'sinden (`rewrites`) gelir:
  `tarayıcı → ön uç → Next → ön uç → API`. Zincir bir hop uzundur.

Tek bir hop sayısı iki yola birden uymaz. Doğrudan yola göre ayarlanırsa tüm web kullanıcıları
Next'in çıkış adresine çözülür; fail-closed oran sınırı tek kovaya döner ve birkaç giriş denemesi
bütün web girişlerini 429'a düşürür. Web'e göre (N+1) ayarlanırsa doğrudan istemci zincirin
solunu yazarak kendi kovasını seçer (fail-open).

Değerlendirilen seçenekler:

1. **Tarayıcı trafiği için servisler arası IAM** (API'yi web'e yalnız dahili açmak). Mobil API'ye
   internetten ulaşmak zorunda; Cloud Run IAM'i servis düzeyindedir, yol başına değil. İki ayrı
   API servisi ya da uygulama içinde ID token doğrulaması gerekir — ikisi de bu sorun için ağır.
2. **İki ayrı hop sayısı, yolu başlıktan tahmin etmek.** Yolu belirten her işaret istemci
   tarafından yazılabilir; tahmin saldırganın seçimidir.
3. **Proxy adresi kendi çözer ve paylaşılan sırla doğrulanan ayrı bir başlıkla iletir.** Seçilen.

## Karar

1. Web ve admin `src/proxy.ts` (Next 16 Proxy, `rewrites`'tan önce çalışır) yalnız `/api/v1/*`
   için çalışır. Tarayıcının gönderdiği `X-Emek-Client-Ip` ve `X-Emek-Proxy-Auth` başlıkları
   **her zaman** silinir.
2. `WEB_PROXY_SECRET` tanımlıysa proxy tarayıcı adresini API ile aynı sağdan-sola semantikle,
   kendi `CLIENT_IP_HOP_COUNT` değeriyle (varsayılan 1) çözer ve `X-Emek-Client-Ip` + sırrı ekler.
   Zincir kısa ya da adres geçersizse hiçbir şey eklemez.
3. API `WEB_PROXY_SECRET` tanımlıysa başlığa **yalnız** sır eşleşirse (sabit süreli
   karşılaştırma, SHA-256 özetleri üzerinden) ve değer tek geçerli bir IP ise güvenir. Aksi her
   durumda mevcut hop sayısı yolu kullanılır — doğrudan (mobil) trafik bundan etkilenmez.
4. Sır Secret Manager'dadır; web, admin ve API aynı sürümü okur. Repoda değer yoktur.
5. Başarısızlık yönü korunur (ADR-0022): yanlış/eksik yapılandırma en kötü ihtimalle ortak
   kovaya düşer, saldırganın seçtiği bir kovaya değil.

## Sonuçlar

- `TRUSTED_PROXY_HOP_COUNT` artık yalnız doğrudan trafiğe göre ayarlanır; web için ayrı
  `CLIENT_IP_HOP_COUNT` vardır. İkisinin de gerçek dağıtımda ölçülmesi gerekir
  ([deployment.md §6](../deployment.md)). `CLIENT_IP_HOP_COUNT=1`, web'e varsayılan Cloud Run
  ön ucundan ulaşıldığı varsayımıdır; önüne Google HTTPS yük dengeleyici konursa zincir
  `istemci, lb` olur ve doğru değer 2'dir.
- Başlığın Next rewrite'ıyla API'ye ulaştığı yerelde Next dev + yankı sunucusuyla doğrulandı;
  E2E'de sır tanımsızdır (başlık eklenmez). Staging'de ilk dağıtım doğrulamasının parçasıdır.
- Web/admin tarafında 32 karakterden kısa sır gönderilmez (API zaten reddeder); geçersiz
  `CLIENT_IP_HOP_COUNT` başlık eklememeye düşer. İkisi de sessizdir — yanlış yapılandırmanın
  belirtisi, tüm tarayıcıların tek oran-sınırı kovasına düşmesidir.
- Next, `X-Forwarded-For` yoksa soket adresini yazar, varsa **dokunmaz**. Web önünde adresi
  ekleyen bir ön uç (Cloud Run / yük dengeleyici) olmadan doğrudan açılırsa tarayıcı zinciri
  kendisi yazabilir; web yalnız ön uç arkasında dağıtılır.
- Sızan sır, sahibine herhangi bir istemci adresi seçtirir (oran sınırı ve audit'teki IP). Etkisi
  hop sayısı hatasıyla aynı sınıftadır; kimlik/yetki kararlarına girmez. Rotasyon: yeni sürüm
  önce API'ye (eski + yeni kabul edilemediği için kısa bir pencerede web başlıkları yok sayılır —
  ortak kovaya düşer, fail-closed), sonra web/admin'e dağıtılır.
- Web ve admin Terraform'da henüz yoktur (R-105); sırrın Secret Manager kaydı ve servislere
  bağlanması o işle birlikte yapılır.
- Next Proxy istek gövdesini tamponlar (varsayılan `proxyClientMaxBodySize` 10 MiB). Tarayıcı
  isteği yarıda keserse (sayfa geçişi) Next bunu `Error: aborted` / `ECONNRESET` olarak günlüğe
  yazar; istek zaten terk edilmiştir ve süreç çalışmaya devam eder. Günlük gürültüsüdür, alarm
  eşiklerine (R-92) dahil edilmemelidir. Yerel mock depolama yolu (`/api/v1/_dev/*`) eşleşmeden
  çıkarılmıştır; üretimde kanıt dosyaları zaten doğrudan imzalı GCS URL'ine gider.
