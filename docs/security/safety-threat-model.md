# Safety Tehdit Modeli (Faz 8)

Kapsam: telemetri, geofence, değerlendirme, panik, operatör uçları, retention.
Tasarım: [safety.md](../architecture/safety.md), [ADR-0019](../architecture/adr/0019-safety-domain.md).

Varlıklar: sağlayıcının anlık konumu ve izi (S1 kişisel veri), müşterinin adresi (hizmet
noktası), güvenlik olay kaydı (kanıt), acil durum kanalının erişilebilirliği.

## Tehditler ve karşı önlemler

| #   | Tehdit                                  | Senaryo                                                      | Önlem                                                                                                                                                                                                                                | Test / durum                                |
| --- | --------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| S1  | Sahte GPS (mock location)               | sağlayıcı konumunu sahte uygulamayla gösterir                | platform `isMock` kaydı → R06; tek başına ceza yok, operatöre uyarı. **Sınır:** root'lu cihazda işaret atlatılabilir; App Check/cihaz bütünlüğü Faz 12-16 (R-65)                                                                     | unit + EXP-004 I04                          |
| S2  | Replay                                  | yakalanmış paket tekrar gönderilir                           | oturum başına monoton sıra; tekrar durum değiştirmez; ret de sırayı tüketir; satır kilidi + koşullu UPDATE                                                                                                                           | integration "replay", "eşzamanlı paketler"  |
| S3  | İmkânsız hareket                        | konum ışınlanır                                              | doğruluk düşülmüş hız > 60 m/sn → ret + bütünlük sayacı → R05; ardışık retlerde çapa yenileme olayı                                                                                                                                  | unit + integration                          |
| S4  | İstemci zaman damgası manipülasyonu     | ileri/geri tarihli `capturedAt`                              | sunucu zamanı yetkili; gelecek (+120 sn), bayat (−900 sn), izleme öncesi, geri giden zaman reddedilir; partition anahtarı sunucu zamanı                                                                                              | unit + integration                          |
| S5  | Oturum ele geçirme / kimlik sahteciliği | başka oturum kimliğiyle telemetri/panik                      | Firebase token doğrulaması; sahiplik **sorgu içinde**; taraf olmayana 404 (varlık sızmaz); müşteri telemetri gönderemez                                                                                                              | integration "authz", "yetkisiz panik"       |
| S6  | Yetkisiz panik                          | üçüncü kişi başkasının hizmetini askıya almaya çalışır       | panik yalnızca oturumun tarafına açık; 404                                                                                                                                                                                           | integration                                 |
| S7  | Panik spam / kötüye kullanım            | taraf tekrar tekrar basar                                    | etkin panik tekil; tekrar yan etkisiz; `(session, panicNumber)` unique. Oran sınırı **bilinçli olarak yok** (Redis bağımlılığı). **Sınır:** kötü niyetli taraf rezervasyonu askıya alabilir — operatör incelemesi + audit izi (R-67) | integration "idempotent", "eşzamanlı panik" |
| S8  | Geofence spoofing                       | sınıra yakın sahte noktalar ile "içerideyim" gösterilir      | geofence tek başına kanıt değildir; debounce + histerezis; check-in tutarsızlığı R10; sahte konum R06                                                                                                                                | unit                                        |
| S9  | Model kötüye kullanımı                  | modele uç değerler verip skor oyunu                          | AI servisi yalnızca core'dan çağrılır (servis anahtarı); girdi şeması aralıklı + `extra=forbid`; model tek başına ≤ WARNING; yanıt core'da yeniden doğrulanır                                                                        | pytest + unit                               |
| S10 | Telemetri seli                          | çok sayıda örnek / istek                                     | paket ≤ 20; örnekler arası ≥ 5 sn (DB tarafı, Redis'ten bağımsız); IP oran sınırı 120/dk (fail-open); olaylar paket başına toplanır                                                                                                  | integration "oran sınırı"                   |
| S11 | Konum sızıntısı                         | loglar, olaylar, taraf API'si, AI servisi                    | koordinat anahtarları log redaksiyonunda; olay/değerlendirme koordinatsız; taraf görünümünde koordinat yok; AI'a yalnızca varışta iki nokta; ham iz yalnızca ADMIN                                                                   | unit (redaksiyon) + integration             |
| S12 | Operatör/admin kötüye kullanımı         | operatör ham izi gereksiz okur ya da alarmı sessizce kapatır | ham iz okuması `SAFETY_LOCATION_ACCESSED` audit; risk kararı gerekçe zorunlu + audit + `RISK_OVERRIDDEN` olayı; `SUPPORT` salt okur; audit hash zinciri (ADR-0013)                                                                   | integration "operatör"                      |
| S13 | Kanıt tahrifatı                         | olay/değerlendirme sonradan değiştirilir                     | append-only trigger + REVOKE; olay sırası `seq`                                                                                                                                                                                      | integration "değiştirilemez"                |
| S14 | Yarış koşulları                         | check-out ↔ panik, değerlendirme ↔ kapanış                   | kilit sırası booking → oturum; değerlendirme yazımında taze okuma; deadlock yeniden deneme                                                                                                                                           | integration "yarış"                         |

## Veri koruma kontrolleri

- Retention ve minimizasyon: [safety.md §10](../architecture/safety.md#10-retention-ve-veri-minimizasyonu).
- Sırlar: AI servis anahtarı mevcut `AI_SERVICE_API_KEY` deseniyle (production'da zorunlu).
- Private nesne yok: safety verisi yalnızca PostgreSQL'dedir.

## Hukuki doğrulama gerektirenler (`TODO(legal)`)

- Ham konum saklama süresi (30 gün) ve panik kanıt süresi (365 gün) — A-04, R-58.
- Dış acil durum kurumuna veri paylaşımı ve entegrasyon — R-59.
- Sağlayıcıya konum toplama aydınlatma metni ve açık rıza/meşru menfaat dayanağı — mobil (Faz 16).
