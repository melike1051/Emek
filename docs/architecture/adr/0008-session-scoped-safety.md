# ADR-0008 — Hizmet Oturumu Bazlı Safety Telemetrisi, Rules + ML Hibriti

- Durum: Accepted (2026-09-20)
- Faz: 8
- Blueprint: §14, §24

## Bağlam

Sağlayıcı güvenliği ürünün merkezinde. Naif çözüm sürekli GPS takibi — ama bu batarya tüketir,
platform politikalarıyla çatışır, KVKK açısından aşırı veri toplar ve kullanıcı güvenini bozar.
Aynı zamanda güvenlik kararını tamamen ML'e bırakmak kabul edilemez gecikme ve hata riski taşır.

## Karar

1. **Telemetri yalnızca aktif hizmet oturumuna bağlı.** 24 saat takip yok.
   ```
   service accepted → pre-service → geofence/arrival → check-in
   → active service telemetry → safety evaluation → check-out → session closed
   ```
   `safety_sessions.status` dışına çıkan hiçbir konum verisi kabul edilmez; oturum kapandığında
   istemci telemetriyi durdurur ve backend yeni `location_events` **reddeder**.
2. **Hibrit değerlendirme:** deterministik rule engine (geofence ihlali, süre aşımı, hareketsizlik,
   rota sapması, check-in/out tutarsızlığı) + ML anomaly score. ML **destekleyici sinyaldir**,
   tek karar verici değildir.
3. **Panic button deterministiktir ve ML beklemez.** Panic isteği:
   - en kısa yolda kaydedilir ve `SafetyAlertRaised` yayınlanır,
   - `EMERGENCY` risk seviyesi anında atanır,
   - ML servisi, matching servisi veya herhangi bir dış servis erişilemez olsa bile **çalışır**
     (bağımlılığı yalnızca DB + event publish; publish başarısız olursa outbox ile garanti edilir),
   - booking `SAFETY_HOLD`'a alınır ve settlement bloklanır.
     Panic akışının p95 gecikmesi ölçülür ve SLO'ya bağlanır.
4. **Risk seviyeleri:** `NORMAL`, `WARNING`, `HIGH_RISK`, `EMERGENCY`. Seviye yükselten her olay
   `safety_events`'e kaynağıyla (`RULE` | `ML` | `USER`) ve `risk_score` ile yazılır.
5. **Veri minimizasyonu ve retention:** yüksek frekanslı `location_events` kısa retention (varsayılan
   öneri 30 gün, `TODO(legal)` ile doğrulanacak) sonrasında agregat/trajektori özetine indirgenir.
   Tablo zamana göre partition'lanır. Dispute/emergency vakalarında ilgili oturum verisi
   hukuki saklama süresi boyunca ayrı ve erişimi loglanan bir alanda tutulur.
6. **AI tek başına emergency kararı vermez.** ML yüksek skoru insan operatörü/acil iş akışını
   tetikler; otomatik olarak üçüncü taraflara ihbar üretmez.
7. **Telemetri istemciden gelir; güvenilmez girdi olarak işlenir.** Konum, zaman ve check-in
   verisi cihazdan gelir (blueprint §9.1 `CheckInDto`); mock-location uygulaması hem geofence
   kurallarını hem kanıt zincirini kandırabilir. Zorunlu karşı önlemler:
   - `location_events` ve check-in/out kayıtlarında **hem** `captured_at` (istemci) **hem**
     `server_received_at` (sunucu) tutulur. Sunucu saati yetkilidir; sınırı aşan saat sapması
     `TELEMETRY_REJECTED` ile reddedilir.
   - Oturum başına **monoton sıra numarası**; tekrar eden veya geri giden sıra reddedilir (replay koruması).
   - Firebase App Check zorunlu; platformun sahte konum sinyali (`isMock`/`isFromMockProvider`)
     ve izin durumu kayda yazılır ve risk skoruna girer.
   - Tek bir sinyal tek başına kanıt sayılmaz: check-in, geofence olayı, süre, before/after dosya
     hash'i ve ödeme olayı birlikte değerlendirilir.
8. **"Dijital ispat" = tamper-evident kanıt, tamper-proof değil.** `documents.sha256` dosyanın
   sonradan değişmediğini gösterir, o dosyanın gerçekten o anda o yerde üretildiğini kanıtlamaz.
   Ürün ve doküman dili bu sınırı yansıtır; dispute kararları tek sinyale dayandırılmaz.

## Gerekçe

Oturum bazlı model teknik gereksinim, batarya ve veri minimizasyonu arasında dengeli tek çözüm.
Panic'in ML'den bağımsız olması hayati: model gecikmesi veya hatası acil durumu geciktiremez.

## Sonuçlar

- Mobil tarafta background location izinleri ve platform gereksinimleri kritik risk (R-05).
- False positive oranı ürün riski: gereksiz alarm güveni yıkar. `WARNING` seviyesi kullanıcıyı
  paniğe sokmadan doğrulama ister. FPR ölçülür (`docs/research/research-metrics.md`).
- Test zorunlu: panic flow bağımlılıklar down iken (T-20), geofence ihlali (T-21), anomaly false
  positive (T-22), oturum kapalıyken gelen telemetri reddi (T-23), retention gerçekten siliyor
  (T-24), sahte/replay/geri tarihli telemetri reddi (T-33).

## Alternatifler

- **Sürekli GPS (reddedildi):** blueprint yasağı, KVKK/batarya/politika sorunları.
- **Yalnız ML (reddedildi):** gecikme ve açıklanamazlık; panic'te kabul edilemez.
- **Yalnız kural (reddedildi):** Ar-Ge iddiası ve tespit kapsamı zayıflar; ML karşılaştırmalı katman olarak kalır.
