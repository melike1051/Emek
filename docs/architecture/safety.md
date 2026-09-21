# Safety Domaini (Faz 8)

Karar kaydı: [ADR-0008](adr/0008-session-scoped-safety.md), [ADR-0019](adr/0019-safety-domain.md).
Kod: `services/api/src/safety/`, `services/ai/app/safety/`. Deney:
[EXP-004](../research/experiments/exp-004-safety-anomaly.md).

## 1. Neden oturum bazlı

Sağlayıcı güvenliği ürünün merkezinde; naif çözüm sürekli GPS takibidir. Reddedildi:
batarya, platform politikaları, KVKK (amaçla sınırlılık ve ölçülülük) ve güven. Emek'te
konum **yalnızca** belirli bir rezervasyonun belirli bir aşamasında, belirli bir amaçla
toplanır ve o amaç bitince kabul edilmez:

- Rezervasyon yok → oturum yok → konum yok.
- Oturum var ama sağlayıcı yola çıkmadı (`PRE_SERVICE`) → konum **reddedilir**.
- Check-out → oturum kapanır → konum **reddedilir**.
- İzleme başlamadan önce alınmış örnek → `CAPTURED_BEFORE_SESSION` ile reddedilir.
- Yalnızca sağlayıcı konum gönderir; müşterinin konumu hiç toplanmaz.

## 2. Yaşam döngüsü

Oturum booking durumunu izler; ikinci bir iş yaşam döngüsü yoktur. Eşleme tek yerde
(`safety-session.state.ts`), çağrı tek yerde (`BookingStateService.transition`, aynı
transaction).

| Booking durumu                                   | Oturum                         | Telemetri  |
| ------------------------------------------------ | ------------------------------ | ---------- |
| `REQUESTED` … `PAYMENT_AUTHORIZED`               | yok                            | —          |
| `SCHEDULED`                                      | `PRE_SERVICE` (açılır)         | reddedilir |
| `PROVIDER_ARRIVING`                              | `ARRIVAL_MONITORING`           | kabul      |
| `CHECKED_IN`, `IN_PROGRESS`                      | `ACTIVE`                       | kabul      |
| `SAFETY_HOLD`                                    | değişmez (izleme sürer)        | —          |
| `CHECKED_OUT`, `CUSTOMER_CONFIRMED`, `COMPLETED` | `CLOSED` (`SERVICE_COMPLETED`) | reddedilir |
| `CANCELLED`                                      | `CLOSED` (`BOOKING_CANCELLED`) | reddedilir |
| `DISPUTED` (askıdan)                             | `CLOSED` (`OPERATOR_CLOSED`)   | reddedilir |

Tablo dışı iki kapanış: operatör (`OPERATOR_CLOSED`) ve süre aşımı (`EXPIRED`: planlanan
bitiş + 12 saat, **yalnızca** `NORMAL`/`WARNING` oturumlar — yüksek riskli oturum
zamanlayıcıyla kapanmaz). Oturumu olmayan eski rezervasyon ileri bir duruma gelince
oturum açılır ve tablodaki adımlarla yürütülür (her adım olay yazar).

Veritabanı invariant'ları: rezervasyon başına tek açık oturum (kısmi unique index,
`ON CONFLICT DO NOTHING` ile eşzamanlı açma güvenli), durum geri gitmez ve `CLOSED`
terminaldir (trigger), kapanış alanları birlikte hareket eder (CHECK).

## 3. Telemetri

`POST /safety/sessions/:id/telemetry` — yalnızca oturumun sağlayıcısı; paket ≤ 20 örnek.
Bir örnek: `sequence`, `capturedAt`, `latitude`, `longitude`, `accuracyMeters`,
isteğe bağlı `speedMps`, `headingDegrees`, `isMockLocation`. İstemci geofence, risk,
oturum durumu gönderemez (bilinmeyen alan 400).

Doğrulama sırası (`telemetry-validator.ts`, saf):

| Neden                     | Koşul                                                            | Bütünlük? | Sayılır? |
| ------------------------- | ---------------------------------------------------------------- | --------- | -------- |
| `SEQUENCE_REPLAY`         | sıra ≤ son sıra (ağ tekrarı / replay) — durum hiç değişmez       | hayır     | hayır    |
| `CLOCK_SKEW_FUTURE`       | `capturedAt` > sunucu + 120 sn                                   | **evet**  | evet     |
| `CLOCK_SKEW_STALE`        | `capturedAt` < sunucu − 900 sn (gecikmeli teslim penceresi dışı) | hayır     | evet     |
| `CAPTURED_BEFORE_SESSION` | izleme başlangıcı − 120 sn'den önce                              | hayır     | evet     |
| `CLOCK_REGRESSION`        | sıra ilerledi ama zaman geri gitti                               | **evet**  | evet     |
| `TOO_FREQUENT`            | önceki örnekten < 5 sn (taşma koruması)                          | hayır     | evet     |
| `IMPOSSIBLE_SPEED`        | doğruluk daireleri düşüldükten sonra > 60 m/sn                   | **evet**  | evet     |

- Replay dışındaki her ret sıra numarasını **tüketir**: aynı numarayla değiştirilmiş
  ikinci gönderim kabul edilemez.
- Hatalı çapa: 3 ardışık imkânsız-hız retinden sonra yeni nokta çapa olur
  (`TELEMETRY_REANCHORED`); aksi hâlde tek kötü fix sonraki tüm doğru örnekleri
  reddettirirdi.
- Zayıf doğruluk **reddedilmez**; saklanır ama geofence kararına girmez.
- Cihaz uykusu: 15 dakikaya kadar tamponlanmış örnekler kabul edilir.
- Bütünlük retleri paket başına **tek** `TELEMETRY_REJECTED` olayına toplanır.

Mesafe PostGIS `ST_Distance(geography)` ile tek sorguda hesaplanır. Sahiplik kontrolü
sorgunun içindedir (`provider_id = $user`); başkasının oturumu 404 alır.

## 4. Geofence

`evaluateGeofence` (saf): doğruluk > sınır (100 m) → `INSUFFICIENT_ACCURACY`; belirsizlik
dairesi bant içinde tamamen içeride → `INSIDE`; tamamen dışarıda → `OUTSIDE`; aksi hâlde
`BOUNDARY`. Bant = max(10 m, yarıçapın %10'u). Debounce: kesin durum 3 ardışık gözlemle
kabul; `BOUNDARY`/`INSUFFICIENT_ACCURACY` adayı sıfırlar, durumu değiştirmez.

Olaylar yalnızca kalıcı değişimde: `GEOFENCE_ENTERED` (→ `INSIDE`), `GEOFENCE_EXITED`
(`INSIDE` →). İlk kesin durumun `OUTSIDE` olması (yola çıkan sağlayıcı) olay değildir.
Geofence tek başına "hizmet başladı/bitti", "dolandırıcılık" ya da "tehlike" **demek
değildir**; bir sinyaldir.

Check-in anındaki kabul edilmiş durum `activation_geofence_state` olarak saklanır.

## 5. Sinyaller (beklenen ↔ gözlenen)

`SafetySignals` (`rules/safety-signals.ts`) kuralların ve modelin **ortak** girdisidir.
`null` "bilinmiyor"dur, "normal" değil; eksik sinyaller `unavailable` listesine yazılır
ve değerlendirme kaydına geçer. Yapı koordinat içermez.

| Grup           | Sinyaller                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| Beklenen       | planlanan başlangıç/bitiş, telemetri aralığı, geofence yarıçapı                                        |
| Yaşam          | izleme başlangıcı, check-in anı, check-in'deki geofence durumu                                         |
| Geofence       | kabul edilmiş durum + süresi, son mesafe, son **kesin** gözlemin yaşı ve yönü                          |
| Telemetri      | son telemetriden beri geçen süre (hiç yoksa izleme başlangıcından), kabul/ret/bütünlük/sahte sayaçları |
| İz (30 dk)     | jitter düşülmüş hareket, pencere süresi, hizmet noktasına mesafe eğilimi                               |
| Geçmiş (60 dk) | ≥ 5 dk örnek boşluğu sayısı, içeriden dışarıya kesin çıkış sayısı                                      |
| Rota           | son konumdan hizmet noktasına ETA ve kaynağı (AI servisi, Faz 7 routing portu)                         |

Hareket ölçümünde her adımdan iki örneğin büyük doğruluğu düşülür: masadaki telefonun
jitter'ı "hareket" sayılmaz.

## 6. Kurallar (`safety-rules-v2`)

| Kural      | Aile      | Koşul (özet)                                                                                     | Seviye              |
| ---------- | --------- | ------------------------------------------------------------------------------------------------ | ------------------- |
| R01 v1     | ARRIVAL   | varışta planlanan başlangıç + 15 dk geçti                                                        | WARNING             |
| R02 **v2** | LOCATION  | hizmette `OUTSIDE`, taze (≤ 5 dk) kesin dışarıda kanıt; süre check-in'den sayılır: > 5 / > 20 dk | WARNING / HIGH_RISK |
| R03 v1     | TELEMETRY | telemetri boşluğu ≥ 10 / ≥ 30 dk (hiç gelmediyse izleme başlangıcından)                          | WARNING / HIGH_RISK |
| R04 v1     | DURATION  | hizmet > max(1,5 × plan, plan + 30 dk)                                                           | WARNING             |
| R05 v1     | INTEGRITY | bütünlük retleri ≥ 3                                                                             | WARNING             |
| R06 v1     | INTEGRITY | sahte konum sinyali                                                                              | WARNING             |
| R07 v1     | ACTIVITY  | varışta, hizmet noktasına ≥ 1 km, son 30 dk'da < 50 m ilerleme (yolda takılma)                   | WARNING             |
| R08 v1     | ARRIVAL   | rota ETA'sına göre tolerans aşılacak (rota yoksa uygulanmaz)                                     | WARNING             |
| R09 v1     | ARRIVAL   | varışta ≥ 10 dk pencerede hizmet noktasından ≥ 1 km uzaklaşma                                    | WARNING             |
| R10 **v2** | LOCATION  | check-in `OUTSIDE` + 5 dk sonra hâlâ içeride görülmedi + taze dışarıda kanıt                     | WARNING             |

Hiçbir kural `EMERGENCY` üretmez, hiçbir kural anomali skorunu okumaz. Hizmet sırasında
"hareketsizlik" kuralı **yoktur**: GPS daire içindeki hareketi göremez (R-62). v1 → v2
değişiklikleri EXP-004 geliştirmesinde bulunan yanlış alarm mekanizmalarıdır.

## 7. Risk toplama (`risk-agg-v1`)

1. Kurallar arası en yüksek.
2. ≥ 2 **farklı ailede** uyarı → `HIGH_RISK`.
3. Anomali (skor ≥ 0,8 ve kalite ≥ 0,5): tek başına en fazla `WARNING`; bir kural
   uyarısıyla birlikte ikinci kanıt (→ `HIGH_RISK` olabilir).
4. Etkin panik → `EMERGENCY`; `EMERGENCY` otomatik düşmez. Diğer seviyeler kurallar
   susunca düşer (`RISK_DEESCALATED`).

Her değerlendirme (`safety_risk_assessments`) kural/toplama/model sürümünü, uygulanan ve
hesaplanan seviyeyi, tetiklenen kuralları kanıtlarıyla, modelin katkılarını, rota
kaynağını ve eksik sinyalleri saklar — yalnızca alarm üretenler değil (FPR'nin paydası).
Olaylar yalnızca **değişimde** yazılır (yeni tetiklenen kural, ilk anomali bayrağı, seviye
değişimi). `HIGH_RISK`'e yükseliş `SafetyAlertRaised` (outbox) üretir; geri dönüşsüz işlem
yapılmaz.

## 8. Anomali modeli sınırı

| Core                                          | AI servisi                                               |
| --------------------------------------------- | -------------------------------------------------------- |
| yetki, oturum durumu, kalıcılık, geçiş, audit | skor + katkılar + kalite + rota tahmini                  |
| sinyalleri üretir, yanıtı yeniden doğrular    | veritabanına erişmez, kimlik/adres/oturum kimliği görmez |
| modelsiz de karar verir                       | karar vermez; yanıtta risk seviyesi alanı yoktur         |

`anomaly-deviation-v2` = her sinyal için parçalı doğrusal sapma + noisy-OR
(`1 − Π(1 − wᵢdᵢ)`), ağırlıklar < 1, + oturum geçmişi (tekrarlayan boşluk/çıkış). Öğrenilmiş
değildir (R-61). v1 karşılaştırma için kayıtlı kalır. Sürüm etiketi kayıtlı bir modeli
seçmek zorundadır (config doğrulaması).

İstemci davranışı: timeout 1,5 sn → `TIMEOUT`; bağlantı → `TRANSPORT`; 5xx / JSON değil /
şema dışı → `INVALID_RESPONSE`; 4xx → `CONTRACT_MISMATCH` (kesinti değil, hata olarak loglanır).

## 9. Panik

`POST /safety/sessions/:id/panic` — oturumun iki tarafı; gövde isteğe bağlı
`category ∈ {THREAT, HEALTH, OTHER}`.

Tek transaction: booking kilidi → oturum kilidi → `panic_raised_at`/`panic_count`,
`EMERGENCY`, kanıt retention uzatması → rezervasyon `SAFETY_HOLD` (savepoint; ödeme donar)
→ `PANIC_RAISED` olayı (`panicNumber`) → audit → outbox `SafetyAlertRaised`. Commit sonrası
bildirim portu (2 sn üst sınır, en iyi çaba).

- Bağımlılık: yalnızca PostgreSQL (+ kimlik doğrulama). Redis oran sınırı yok, AI yok, rota yok.
- Etkin panik varken tekrar basış → `duplicate: true`, yan etki yok (iki taraf aynı anda
  bassa da). `(session, panicNumber)` unique index son savunma.
- Operatör `EMERGENCY`'den indirirse panik **çözülür**; sonraki panik yeni olaydır.
- Kapalı oturum → 409; istemci kullanıcıyı 112'ye yönlendirir (R-59).
- Deadlock/serileştirme hatası 3 kez yeniden denenir.

## 10. Retention ve veri minimizasyonu

| Veri                          | Süre                                        | Sonrası                                            |
| ----------------------------- | ------------------------------------------- | -------------------------------------------------- |
| Ham konum (`location_events`) | planlanan bitiş + 30 gün (`TODO(legal)`)    | silinir                                            |
| Panik oturumunun ham konumu   | en az panik + 365 gün (`TODO(legal)`, R-58) | silinir                                            |
| Oturum son konumu             | ham konumla aynı                            | NULL                                               |
| Hizmet noktası (oturumda)     | ham konumla aynı                            | ~1 km'ye yuvarlanır (araştırma özeti kalır)        |
| Olaylar, değerlendirmeler     | append-only (koordinat içermez)             | kalır; silme politikası R-38 ile birlikte (Faz 12) |

Bakım işi yalnızca **kapalı** oturumları temizler, `SKIP LOCKED` ile. `location_events`
aylık partition'lıdır (+ DEFAULT emniyet ağı); bakım işi bu ay ve gelecek ay için
partition açar. Retention bugün satır silmedir; partition düşürme Faz 12'de (R-69).
FK tasarımı: `location_events` → oturum `CASCADE`; olay/değerlendirme → oturum
`RESTRICT` (kanıt); `safety_events.actor_user_id` FK'sizdir (append-only tabloda
`SET NULL` bir UPDATE'tir ve kişisel veri silmeyi kilitlerdi).

## 11. Hata ve bozulma davranışı

| Durum                               | Davranış                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| AI timeout / bağlantı / 5xx / bozuk | değerlendirme kurallarla tamamlanır; `anomaly` eksik sinyal, neden kayıtlı; metrik `safety.anomaly.unavailable` |
| AI 4xx                              | `CONTRACT_MISMATCH` — hata logu (sözleşme ayrışması), kurallarla devam                                          |
| Rota yok / sağlayıcı düştü          | ETA uydurulmaz; R08 uygulanmaz; `route` eksik sinyal                                                            |
| Redis yok                           | telemetri kabul edilir (fail-open, DB koruması sürer); panik etkilenmez; diğer uçlar fail-closed                |
| Pub/Sub / outbox yayını             | olay DB'de; outbox at-least-once yeniden dener (Faz 9)                                                          |
| Bildirim portu hatası               | panik zaten kalıcı; metrik `safety.panic.notification_failed`                                                   |
| Deadlock / serileştirme (panik)     | 3 deneme                                                                                                        |
| Telemetri gelmiyor                  | "normal" sayılmaz: R03 izleme başlangıcından ölçer; izleyici zamanla değerlendirir                              |
| Değerlendirme sırasında kapanış     | sonuç atılır (`DISCARDED_SESSION_NOT_ACTIVE`)                                                                   |
| Değerlendirme sırasında panik       | `EMERGENCY` korunur                                                                                             |

Asla bozulmayanlar: panik, yetki/sahiplik, oturum durumu, güvenlik kaydı kalıcılığı.

## 12. Güvenlik modeli

Ayrıntı ve tehdit modeli: [security/safety-threat-model.md](../security/safety-threat-model.md).
RBAC: [rbac-matrix.md](../security/rbac-matrix.md). Özet: kimlik doğrulama zorunlu (deny by
default), sahiplik sorgu içinde, operatör uçları `ADMIN`/`SUPPORT`, ham iz yalnızca
`ADMIN` + audit, koordinatlar log redaksiyonunda maskelenir.

## 13. Gözlemlenebilirlik

Log tabanlı metrikler (`safety-metrics.ts`, sabit adlar, koordinat/kimlik yok):
`safety.telemetry.batch` (kabul/ret/gecikme), `safety.telemetry.rejected` (neden),
`safety.geofence.transition`, `safety.evaluation.completed` (toplam ve anomali gecikmesi),
`safety.evaluation.discarded`, `safety.anomaly.unavailable` (neden), `safety.route.unavailable`,
`safety.risk.changed`, `safety.panic.raised` (gecikme, tekrar mı, askı uygulandı mı),
`safety.panic.notification_failed`, `safety.session.transition`, `safety.retention.purged`,
`safety.monitor.failed`. Korelasyon: istek kimliği (request context) + oturum kimliği.
Cloud Monitoring bağlantısı Faz 13.

## 14. API

| Uç                                            | Rol / sahiplik                              |
| --------------------------------------------- | ------------------------------------------- |
| `GET /bookings/:id/safety-session`            | rezervasyonun tarafı; dar görünüm           |
| `POST /safety/sessions/:id/telemetry`         | oturumun sağlayıcısı; oran sınırı fail-open |
| `POST /safety/sessions/:id/panic`             | oturumun iki tarafı; oran sınırı yok        |
| `GET /safety/operator/sessions?minRisk=`      | `ADMIN`, `SUPPORT`                          |
| `GET /safety/operator/sessions/:id`           | `ADMIN`, `SUPPORT` (değerlendirme + olay)   |
| `GET /safety/operator/sessions/:id/locations` | `ADMIN` + audit                             |
| `POST /safety/operator/sessions/:id/risk`     | `ADMIN`, gerekçe zorunlu, audit             |
| `POST /safety/operator/sessions/:id/close`    | `ADMIN`, audit                              |
| `POST /safety/operator/sessions/:id/evaluate` | `ADMIN`                                     |

Oturum açma ucu yoktur (oturum booking'den türer). Askıyı kaldırmak mevcut booking geçiş
ucudur (`SAFETY_HOLD → IN_PROGRESS/CANCELLED/DISPUTED`, `ADMIN`).

## 15. Bilinen sınırlar

R-54 … R-69 ([technical-risks.md](../research/technical-risks.md)). En önemlileri: dış
acil durum entegrasyonu yok (R-59), eşikler ve model sentetik veriyle kuruldu (R-57, R-61,
R-63), cihaz uykusu gerçek zamanlı ayırt edilemez (R-55), eşzamanlı panik gecikmesi
(R-54), mobil istemci ve arka plan konum izinleri henüz yok (R-05, Faz 16).
