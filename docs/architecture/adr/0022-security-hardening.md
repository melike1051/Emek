# ADR-0022 — Güvenlik Sertleştirme: Proxy Güveni, App Check, Zincir Doğrulama, Retention

- Durum: Accepted (2026-09-23)
- Faz: 12
- Blueprint: §5 (Cloud-Native Operations — Security), §13 (Güvenlik ve KVKK)
- İlgili: ADR-0003 (rate limiting), ADR-0004 (identity hash), ADR-0013 (RBAC + audit),
  ADR-0016 (Firebase Auth)

## Bağlam

Faz 12'ye girerken dört koruma "belgelenmiş ama zorlanmamış" durumdaydı:

1. **Oran sınırı IP bazlıydı ve proxy güveni yapılandırılmamıştı (R-53).** Cloud Run
   arkasında tüm istekler tek bir ön uç adresinden görünür: sınır ya global bir kovaya
   dönüşür (tek istemci herkesin kotasını tüketir) ya da naif `trust proxy` ile
   `X-Forwarded-For` üzerinden atlatılabilir hale gelir.
2. **App Check için hiçbir backend desteği yoktu.** CLAUDE.md stack tablosu "client
   integrity: Firebase App Check" diyordu; kodda karşılığı yoktu.
3. **Audit hash zinciri yazılıyordu ama hiç doğrulanmıyordu.** Zincir
   tamper-_evident_'tır: kopukluk ancak birisi baktığında görünür. Bakan yoktu.
4. **Saklama süreleri belgeliydi, silen iş yoktu (R-38).** `markDeleted` iletişim
   alanlarını boşaltıyordu ama profil adı, biyografi ve açık adres kalıyordu; üstelik
   silme talebinin ne zaman geldiği kayıtlı olmadığı için bir saat bile başlatılamıyordu.

Ayrıca hesap kurtarmada (R-36) operatör onayının **bağımsızlığı** hiçbir yerde
zorlanmıyordu.

## Karar

### 1. İstemci adresi, güvenilen hop sayısıyla çözümlenir

Express'in `trust proxy` ayarı **açılmaz**. İstemci adresi
`resolveClientIp(request, TRUSTED_PROXY_HOP_COUNT)` ile çözümlenir: adres listesi
`[soket, ...xff.reverse()]` kurulur ve `n`. eleman seçilir. Zincir sağdan okunduğu için
saldırganın sola yazdığı girdiler seçime hiç giremez.

- `TRUSTED_PROXY_HOP_COUNT = 0` → hiçbir başlığa güvenilmez (varsayılan, yerel).
- Cloud Run → `2` ("istemci, google-lb" + soket). Değer Faz 13'te gerçek topoloji
  üzerinde doğrulanacaktır.
- Zincir beklenenden kısaysa **fail-closed**: soket adresine düşülür. Yanlış
  yapılandırma sınırı daraltır, saldırgan kontrolündeki bir değere genişletmez.

Production'da `0` bırakmak config doğrulamasında reddedilir: sessiz varsayılanla
çıkmak, sınırı olmayan bir sistemi "sınırlı" sanmaktır.

### 2. Kullanıcı başına ikinci bir oran sınırı katmanı

IP sınırı (`@RateLimit`, `AuthGuard`'dan önce) kimlik doğrulama maliyetini korur ama
paylaşılan bir kovadır. `@UserRateLimit` (`AuthGuard`'dan sonra) pahalı ve suistimale
açık uçlarda hesabı kendi kotasına bağlar: eşleştirme, rezervasyon, serbest metin
talebi, doküman kaydı/indirme, uyuşmazlık, değerlendirme, ödeme yetkilendirme, kimlik
doğrulama oturumu. Kimliksiz istekte sayaç tutulmaz — o trafiği IP katmanı karşılar;
iki kez saymak `@Public()` uçlarını iki kere cezalandırırdı.

Her iki katman da **fail-closed**'dır (ADR-0003). Panik ucu hiçbir oran sınırı
kullanmaz (ADR-0008 §3): gerçek bir basış reddedilemez.

### 3. App Check zorunluluğu, istisnalar açıkça işaretlenerek

`AppCheckGuard` **deny by default** çalışır; guard sırası
`oran sınırı → App Check → kimlik → rol → kullanıcı kotası`. App Check kimlikten önce
gelir: uygulamadan gelmeyen trafik JWKS ve veritabanı maliyetine hiç ulaşmamalıdır.

İstisnalar `@SkipAppCheck()` ile işaretlenir ve yalnızca **istemci uygulamasından
gelmeyen** uçlardır: ödeme webhook'u, kimlik callback'i, health probe'ları. Bu uçların
kendi doğrulama modeli vardır (HMAC imza) ve App Check token'ı hiçbir zaman taşıyamazlar
— ortada mobil uygulama yoktur.

App Check **yetkilendirme değildir**: geçen bir istek hâlâ `AuthGuard` ve RBAC
kapılarından geçer. Mobil taraftaki token üretimi **Faz 16**'nın işidir; bu fazda
yalnızca backend zorunluluğu ve doğrulayıcı vardır.

### 4. Audit zinciri artımlı ve gözlemlenebilir biçimde doğrulanır

Faz 2'nin `audit_chain_broken_at()` fonksiyonu tüm tabloyu baştan tarar; saatlik bir iş
için ölçeklenmez. `audit_chain_verify_range(from_id, expected_prev, limit)` artımlı
doğrulama yapar ve `audit_chain_checkpoints` en son doğrulanan satırı + hash'ini tutar.
Bir sonraki tur bu hash'i beklenen `prev_hash` olarak kullanır: böylece hem yeni satırlar
hem de **zaten doğrulanmış geçmişin yeniden yazılması** yakalanır.

- Doğrulama hiçbir audit satırını **değiştirmez**; yalnızca checkpoint ekler.
- `audit_chain_checkpoints` ve `audit_exports` de append-only trigger'ıyla korunur:
  doğrulama geçmişi de kanıttır, sonradan "hep OK'ti" diye düzeltilememelidir.
- Kopukluk bulunduğunda doğrulama **kendiliğinden ilerlemez**: bozuk aralığı sessizce
  atlamak bulguyu kaybetmek olurdu. Operatör inceleyip yeni bir başlangıç belirlemelidir.
- Kopukluk istisna değil **bulgudur**: uç 200 döner ve durumu gösterir.

Retention-locked dışa aktarım (ADR-0013 §8) `AuditArchive` portu arkasındadır: doğrulanmış
parçalar JSONL olarak yazılır, özeti `audit_exports.sha256`'ya kaydedilir. **Yalnızca
doğrulanmış aralık arşivlenir** — bozuk bir parçayı "kanıt" diye değişmez depolamaya
yazmak kanıtı değersizleştirir. Bu fazda yalnızca bellek uygulaması bağlıdır; gerçek GCS
arşivi ve bucket retention policy'si **Faz 13**'e aittir (R-82) ve production config'i
bellek arşiviyle dışa aktarımı reddeder.

### 5. Retention silen bir iştir, bir politika metni değil

`RetentionService` env'den gelen sürelere göre gerçekten siler. Kapsam dışı bırakılanlar
bilinçlidir: `audit_logs` (append-only, zincir kırılır), `bookings`/`payments`/`disputes`
(mali ve hukuki saklama), `location_events` (kendi politikası
`SafetyMaintenanceService`'te; iki yerden silmek yarış üretirdi).

Kapatılmış hesap **silinmez, anonimleştirilir**: `audit_logs`, `bookings` ve `payments`
ona atıfta bulunur ve satırı silmek denetim izini ve uyuşmazlık kanıtını birlikte
götürürdü. `users.deleted_at` saklama saatini başlatır (tekrarlanan kapatma çağrısı
saati **sıfırlamaz**), `anonymized_at` sonucu kaydeder; görünen ad sabit bir pseudonime
döner, biyografi ve açık adres kaldırılır, koordinat kabalaştırılır.

`TODO(legal)`: KVKK silme talebinin anonimleştirme ile karşılanıp karşılanmadığı ve mali
kayıt saklama yükümlülüğünün süresi hukuk görüşüyle doğrulanacaktır (A-04).

### 6. Operatör onayı bağımsız olmak zorundadır (R-36)

`approveRecovery`, onaylayanın talebin tarafı (talep sahibi veya hedef hesap) olmasını
reddeder. Faz 3 otomatik devri kaldırıp taşımayı operatör onayına bağlamıştı, ama onayın
bağımsızlığı zorlanmıyordu: ADMIN rolü taşıyan bir saldırgan kendi talebini kendisi
onaylayarak kaldırılmış olan devralma yolunu geri getirebilirdi. Ret talebi **kapatmaz**:
talep geçerli olabilir, yalnızca bu onaylayan uygun değildir.

`rejectRecovery` bilinçli olarak aynı kısıta tabi **değildir**: reddetmek bir devralma
yolu açmaz, transferi engeller. Hedef hesabın kendi hesabına yapılan bir kurtarma
denemesini reddetmesi zararsızdır; aynı kısıtı oraya da koymak, saldırı altındaki
kullanıcıyı kendi savunmasından alıkoyardı.

### 7. Identity HMAC anahtarı: rotasyon değil, yeniden doğrulama göçü

ADR-0004 §5 gereği `identity_hash` anahtarının rotasyonu **yoktur**: anahtar değişirse
tüm hash'ler değişir ve tekillik index'i anlamını kaybeder. Anahtarın değişmesi
gerekirse (sızıntı, KMS anahtarı imhası) izlenecek yol
`docs/security/identity-key-migration.md`'dedir ve **otomatik değildir**: yeni anahtarla
yeni bir `identity_hash` ancak kullanıcı **yeniden doğrulama** yaptığında üretilebilir,
çünkü ham kimlik numarası hiçbir yerde saklanmaz. Bu, tasarımın bir sonucudur, bir
eksiklik değil.

### 8. Bağımlılık taraması ve SAST CI'da bloklayıcıdır

`npm audit --audit-level=high`, `pip-audit --strict` ve `semgrep --error` (kayıt defteri
paketleri + `.semgrep.yml`'deki Emek kuralları) CI'da kapıdır, raporlayıcı değil.
İstisnalar kodda `nosemgrep` ile işaretlenir ve code review'da görünür olur;
`overrides` gerekçeleri ADR-0015'tedir.

## Sonuçlar

**Olumlu.** IP bazlı sınır artık başlık sahteciliğiyle atlatılamıyor ve hesap başına
ikinci bir katman var. Audit zincirinin kopukluğu tespit edilebilir ve testli. Saklama
süreleri gerçekten siliyor. Kurtarmada bağımsız onay zorunlu. Güvenlik regresyonları
CI'da yakalanıyor.

**Olumsuz / kabul edilen.** Production config'i artık daha fazla ayar zorunlu kılıyor;
yanlış `TRUSTED_PROXY_HOP_COUNT` sınırı gereğinden fazla daraltabilir (fail-closed
tercih edildi). App Check zorunluluğu Faz 16'daki mobil istemci gelene kadar gerçek
trafikte doğrulanamaz. Retention-locked arşiv Faz 13'e kadar gerçek değildir (R-82).
Zincir doğrulaması tek instance'ta seri çalışır; çok büyük tablolarda tur başına
`AUDIT_VERIFICATION_BATCH_SIZE` satır ilerler.
