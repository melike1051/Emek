# Production Readiness Review (Faz 17)

Tarih: 2026-09-30. Kapsam: `main` + Faz 15-17 dalları. Kaynaklar: [technical-risks.md](../research/technical-risks.md),
[phase-plan.md](phase-plan.md), [deployment.md](deployment.md), [penetration-test-checklist.md](../security/penetration-test-checklist.md).

## Karar

| Hedef                                | Karar           | Gerekçe                                                                                                                                                        |
| ------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TÜBİTAK demosu (yerel ortam)         | **HAZIR**       | Tam zincir E2E yeşil; AI açık/kapalı iki varyant CI'da ([demo-scenarios.md](../research/demo-scenarios.md))                                                    |
| Kapalı pilot (staging, mock PSP/KYC) | **HAZIR DEĞİL** | Altyapı hiç uygulanmadı (R-93), admin dağıtımı yok (R-105), web IP modeli (R-107)                                                                              |
| Üretim (gerçek kullanıcı + para)     | **HAZIR DEĞİL** | Yukarıdakiler + lisanslı PSP/KYC sözleşmesi (R-01, R-02), hukuki doğrulamalar (`TODO(legal)`), acil durum entegrasyonu (R-59), sağlayıcı adres erişimi (R-102) |

Kod tarafında bilinen bir doğruluk hatası açık bırakılmadı; kalan engeller dış bağımlılık, bulut
doğrulaması ve ürün kararlarıdır.

## Faz 17'de bulunan ve düzeltilen

- **Randevu müşteri onayında takılıyordu (kritik).** `CUSTOMER_CONFIRMED → COMPLETED` bir SYSTEM
  geçişidir ama üretimde onu yapan hiçbir kod yolu yoktu — yalnız testler `advanceBySystem` ile
  elle ilerletiyordu. Sonuç: her gerçek randevu onayda kalır, ödeme `SERVICE_COMPLETED` olmaz,
  ne operatör ne zamanlanmış iş parayı serbest bırakabilir, randevu hiç `SETTLED` olmaz,
  değerlendirme formu açılmaz. Düzeltme: müşteri onayı aynı transaction'da SYSTEM `COMPLETED`
  geçişini uygular (`bookings.service.ts`). Para yine otomatik çıkmaz; uyuşmazlık penceresi
  `COMPLETED`'dan başlar. Testler artık elle ilerletmez, gerçek yolu sınar.
- **CI'da container build işinin başlığı kaybolmuştu.** Faz 15-16 commit'inde `containers:` satırı
  silinmiş, mobil iş yinelenen `runs-on`/`steps` anahtarları taşıyordu. Workflow ya ayrıştırılamaz
  (GitHub yinelenen anahtarı reddeder) ya da Flutter adımları docker adımlarıyla ezilmiş olarak
  çalışır; iki durumda da mobil testler CI'da sınanmıyordu. Geri getirildi.

## Alan bazında durum

| Alan                  | Durum | Kanıt / açık nokta                                                                                                                                                   |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booking state machine | ✅    | Merkezî transition map, `EXCLUDE USING GIST`, geçmiş + audit aynı transaction'da; tam zincir E2E                                                                     |
| Ödeme orkestrasyonu   | ⚠️    | Mock adapter'la uçtan uca; webhook/komut idempotency'si entegrasyon testli. Gerçek PSP yok (R-02), barındırılan ödeme/3DS sayfası yok (R-100)                        |
| Kimlik                | ⚠️    | Adapter + `identity_hash` UNIQUE. Gerçek KYC/EKDS erişimi yok (R-01), mobilde doğrulama başlatılamıyor (R-111)                                                       |
| AI / eşleştirme       | ✅    | Sürümlü karar kaydı, yedek yol; CI'da AI açık/kapalı. Metrikler **sentetik** (R-45, R-63)                                                                            |
| Safety                | ⚠️    | Panik deterministik, telemetri oturum bazlı. Dış acil durum entegrasyonu yok (R-59), saklama süreleri hukuken doğrulanmadı (R-58), fiziksel cihaz ölçümü yok (R-110) |
| Güvenlik              | ⚠️    | Guard sırası, App Check, audit zinciri doğrulayıcısı, SAST/dependency kapısı. Web proxy IP modeli (R-107), CSP nonce yok (R-105)                                     |
| Altyapı / dağıtım     | ❌    | Terraform + deploy hattı yazıldı, **hiç uygulanmadı** (R-93); alarmlar hiç tetiklenmedi (R-92); admin için servis yok (R-105)                                        |
| Performans            | ⚠️    | EXP-007 ölçümleri **yerel**; Cloud Run/Cloud SQL üzerinde tekrarlanmadı                                                                                              |
| Mobil                 | ⚠️    | 4/4 simülatör + Android emülatör testi; mağaza imzalama, APNs (R-112), fiziksel cihaz yok                                                                            |
| Test                  | ✅    | Birim + 460 entegrasyon + 11 E2E; E2E CI'da iki varyant (R-106 web kısmı kapandı)                                                                                    |
| Ürün                  | ❌    | Sağlayıcı hizmet adresini göremiyor (R-102) — gerçek hizmet verilemez                                                                                                |

## Pilot öncesi zorunlu (go/no-go)

Her madde tamamlanmadan kapalı pilot başlamaz. Sahibi ve kanıtı dolduruluncaya kadar açık sayılır.

- [ ] R-93: Terraform staging'de `apply`; `npm run smoke -- --environment staging` yeşil
- [ ] R-105: admin için ayrı Cloud Run servisi + erişim kısıtı (IAP/IP allowlist); nonce tabanlı CSP
- [ ] R-107: web proxy'si için güvenilir istemci IP modeli + iki yolun ayrı dağıtım testi
- [ ] R-102: sağlayıcının kabul ettiği randevunun adresine erişimi (sahiplik + zaman penceresi)
- [ ] R-92: her alarm politikası staging'de bilinçli olarak bir kez tetiklendi
- [ ] Staging'de tam zincir E2E (`web.full-lifecycle.spec.ts`'in staging uyarlaması — seed yardımcısı
      bugün yerel olmayan hedefi **bilinçli olarak reddeder**; staging için API tabanlı ayrı bir seed gerekir)
- [ ] EXP-007 yük testleri Cloud Run/Cloud SQL üzerinde tekrarlandı

## Üretim öncesi ek zorunlu

- [ ] R-01 / R-02: lisanslı KYC ve ödeme kuruluşu sözleşmesi + gerçek adapter + sandbox E2E
- [ ] R-100: barındırılan ödeme/3DS sayfası (web + mobil)
- [ ] R-58 / R-59 ve tüm `TODO(legal)` noktaları hukuk onayından geçti
- [ ] R-110 / R-112: fiziksel Android + iOS cihazda 2 saatlik oturum, APNs ile push
- [ ] Sızma testi ([penetration-test-checklist.md](../security/penetration-test-checklist.md)) dış ekip tarafından koşuldu
