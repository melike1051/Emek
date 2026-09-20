# ADR-0001 — Modular Monolith + Ayrık AI/Optimization Servisleri

- Durum: Accepted (2026-09-20)
- Faz: 1
- Blueprint: §3, §19, §24, §31

## Bağlam

Emek marketplace, AI karar motoru, safety telemetrisi, ödeme orkestrasyonu ve analitik katmanlarını
birleştiriyor. Küçük bir ekip, TÜBİTAK takvimi ve henüz bilinmeyen gerçek yük profili var.
Domain sayısı (18 modül) mikroservise bölünmeye davetiye çıkarıyor.

## Karar

Başlangıç mimarisi **modular monolith**: tüm transactional business logic tek NestJS deployment'ında,
net domain modül sınırlarıyla (`services/api/src/<domain>/`). Yalnızca **farklı runtime veya bağımsız
ölçekleme gereksinimi kanıtlanmış** parçalar ayrı servis olur: Python AI/NLP, matching/optimization,
anomaly detection (`services/ai`).

Kubernetes ve service mesh kapsam dışıdır. Compute: Cloud Run.

Yeni bir servis çıkarmak için şu üçünden en az biri kanıtlanmalıdır:

1. Farklı runtime/dil zorunluluğu (ör. OR-Tools → Python).
2. Ölçüm ile gösterilmiş bağımsız ölçekleme ihtiyacı (CPU/bellek profili core'dan ayrışıyor).
3. Farklı availability/izolasyon sınıfı (ör. panic flow'un core deploy'undan etkilenmemesi).

## Gerekçe

- Küçük ekipte dağıtık sistem operasyon yükü (servis keşfi, dağıtık transaction, çoklu pipeline)
  ürün riskini artırır, Ar-Ge çıktısını artırmaz.
- Booking + payment + status history aynı PostgreSQL transaction'ında tutulabildiği sürece
  tutarlılık bedava gelir; servislere bölmek saga/compensation karmaşıklığı ekler.
- Modül sınırları korunduğu sürece ileride servis çıkarmak düşük maliyetlidir; tersi doğru değildir.

## Sonuçlar

**Olumlu:** tek transaction sınırı, tek CI hattı, düşük operasyonel yük, hızlı iterasyon.

**Olumsuz / yönetilecek:** modül sınırlarının erozyon riski. Karşı önlemler:

- Modüller arası erişim yalnızca modülün public service arayüzünden; başka modülün repository'sine
  veya entity'sine doğrudan erişim yasak (lint kuralı ile zorlanacak — Faz 2).
- Cross-domain yan etkiler senkron çağrı yerine domain event ile (Faz 9).
- Her modül kendi migration'ını ve testini taşır.

## Alternatifler

- **Mikroservisler (reddedildi):** ekip kapasitesine göre erken karmaşıklık; blueprint §24 açıkça yasaklıyor.
- **Tek Python monolith (reddedildi):** ADR-0002.
- **Kubernetes (ertelendi):** gerçek ölçek/operasyon ihtiyacı oluştuğunda yeniden değerlendirilir.
