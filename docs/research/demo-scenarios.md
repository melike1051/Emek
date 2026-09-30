# TÜBİTAK Demo Senaryoları (Faz 17)

Demo, beş Ar-Ge eksenini ([research-metrics.md §1](research-metrics.md)) çalışan ürün üzerinde
gösterir. Her senaryonun arkasında otomatik bir test vardır; demoda görülen akış, CI'da her
değişiklikte koşan akışla aynıdır.

| Senaryo                              | Eksen                       | Arkasındaki test                                                                       |
| ------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------- |
| S1 Talepten mutabakata tam zincir    | NLP, Matching, Optimization | `e2e/tests/web.full-lifecycle.spec.ts` (CI: AI açık varyant)                           |
| S2 Sağlayıcı başvurusu ve onayı      | Güven (kimlik, doğrulama)   | `e2e/tests/web.provider-onboarding.spec.ts`, `admin.providers.spec.ts`                 |
| S3 Sağlayıcının randevu kararı       | Marketplace                 | `e2e/tests/web.booking.spec.ts`                                                        |
| S4 Hizmet oturumu ve acil durum      | Safety                      | `e2e/tests/web.panic.spec.ts`, `apps/mobile/integration_test/telemetry_flow_test.dart` |
| S5 Denetlenebilirlik ve bozulmuş mod | Platform                    | `web.full-lifecycle.spec.ts` (audit zinciri), CI AI kapalı varyant                     |

## Hazırlık

```bash
npm run infra:up && npm run migrate:up && npm run seed:catalog --workspace=@emek/api
npm run dev --workspace=@emek/api                                  # AUTH_PROVIDER=mock
cd services/ai && uv run uvicorn app.main:app --port 8000          # AI servisi (S1 için şart)
npm run dev --workspace=@emek/web & npm run dev --workspace=@emek/admin
npx tsx e2e/scripts/seed-demo.ts                                   # aktörler + giriş bilgileri
```

`seed-demo.ts` her senaryonun aktörlerini kurar ve geliştirici girişi için kimlik + telefonu
yazdırır. Yalnız yerel hedeflere yazar; staging/production'a yönelemez. Demo öncesi provaya
`npm run test:e2e` ile başlanır: 11 test geçmiyorsa demo yapılmaz.

## S1 — Talepten mutabakata tam zincir

Aktörler: S1 müşterisi (yeni hesap), S1 sağlayıcısı (Kızılay'da hizmet bölgesi), operatör.

1. **Müşteri** (web): rol seçimi → adres (Ankara / Çankaya, seed çıktısındaki enlem/boylam).
2. Talebi **serbest metinle** yazar (ör. _"Yarın öğleden sonra 3 saatlik detaylı temizlik"_).
   Gösterilecek: yapılandırılmış talep, `parser_version` + `parser_confidence`; düşük güvende
   formla düzeltme yolu. → NLP ekseni ([EXP-001](experiments/exp-001-nlp-baseline-vs-heuristic.md),
   [EXP-003](experiments/exp-003-confidence-calibration.md)).
3. **Sağlayıcı bul** → eşleşme ekranı: "Neden bu sağlayıcı?" skor bileşenleri. Anlatılacak:
   seçim LLM'e bırakılmaz; retrieval → hard constraints → scoring → OR-Tools → açıklama.
   Karar `matching_runs`'a `algorithm_version` ile yazılır. → Matching/Optimization
   ([EXP-002](experiments/exp-002-matching-baseline-vs-optimized.md): sentetik veride Recall@1
   0.46, baseline 0.24; hard constraint ihlali 0).
4. **Sağlayıcı** kabul eder → **müşteri** ödemeyi onaylar: para lisanslı kuruluşta tutulur
   ("Güvende tutuluyor"), Emek escrow kurmaz.
5. **Sağlayıcı** hizmet günü adımları: Yola çıktım → Adrese vardım → Hizmeti başlat → Hizmeti
   bitirdim (önce/sonra kanıt fotoğrafı eklenebilir; `sha256` storage'dan okunur).
6. **Müşteri** hizmeti onaylar → randevu `COMPLETED`; para **hâlâ çıkmaz** (uyuşmazlık penceresi).
   Değerlendirme bırakır.
7. **Operatör** (admin → Ödemeler) serbest bırakır → randevu `SETTLED`.

## S2 — Sağlayıcı başvurusu

Başvuran sağlayıcı admin "Sağlayıcılar" ekranında incelemededir. Gösterilecek: 1 insan = 1
hesap (`identity_hash` üzerinde veritabanı UNIQUE kısıtı), ham T.C. kimlik numarasının hiçbir
tabloda bulunmaması, onay kararının audit'e yazılması.

## S3 — Sağlayıcının randevu kararı

S3 sağlayıcısı `/panel/randevular/<id>` ekranında onay bekleyen randevuyu görür; kabul veya
gerekçeli ret. Anlatılacak: geçişler tek merkezî transition map'ten geçer, her geçiş
`booking_status_history`'ye yazılır; başka bir müşteri aynı randevuyu açamaz (deny by default).

## S4 — Hizmet oturumu ve acil durum

S4 randevusu planlanmıştır. Müşteri `/randevular/<id>/guvenlik`: hizmet başlamadan panik
butonu yoktur (112 yönlendirmesi vardır). Sağlayıcı "Yola çıktım" dedikten sonra acil durum
tek onayla bildirilir; risk anında `EMERGENCY` olur, ödeme dondurulur. Anlatılacak: panik
deterministiktir, ML'i beklemez; 24 saat takip yoktur, telemetri yalnız oturum boyuncadır.
→ Safety ([EXP-004](experiments/exp-004-safety-anomaly.md), **sentetik** veri).

Mobil telemetri (arka plan konum, geofence) emülatörde gösterilir; fiziksel cihazda uzun süreli
davranış henüz ölçülmedi (R-110) — demoda bu açıkça söylenir.

## S5 — Denetlenebilirlik ve bozulmuş mod

- Admin → Operasyon: audit hash zinciri doğrulaması `OK`; zincir tamper-evident'tır.
- AI servisi durdurulur, S1 3. adım tekrarlanır: eşleşme yedek yoldan
  (`fallback-distance-v1`) yine üretilir, ekranda "Eşleştirme sınırlı modda yapıldı" görünür.
  → Platform ekseni ([EXP-007](experiments/exp-007-performance-baseline.md), **yerel** ölçüm).

## Demoda söylenmemesi gerekenler

Aşağıdakiler bugün **doğru değildir** (ayrıntı: [production-readiness.md](../architecture/production-readiness.md)):

- "Canlı ortamda çalışıyor" — Faz 13 Terraform'u gerçek GCP'de uygulanmadı.
- "Gerçek kullanıcı verisiyle ölçüldü" — matching/safety metrikleri sentetik, performans yerel.
- "Gerçek ödeme/kimlik sağlayıcısıyla entegre" — ikisi de mock adapter arkasında (R-01, R-02).
