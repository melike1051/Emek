# ADR-0003 — PostgreSQL + PostGIS Tek Transactional Source of Truth

- Durum: Accepted (2026-09-20)
- Faz: 1
- Blueprint: §7, §24, §25

## Bağlam

Booking, payment, availability, rol ve state geçişleri güçlü tutarlılık ister. Coğrafi sorgular
(hizmet alanı içinde mi, en yakın provider, mesafe eşiği) veri katmanında çalışmalı. Firestore
realtime chat/presence için cazip ama finansal/ilişkisel çekirdek için uygun değil.

## Karar

- **PostgreSQL** tek transactional source of truth. Booking, payment, identity, availability,
  safety session, audit — hepsi burada.
- **PostGIS** coğrafi tipler ve indeksler için (`GEOGRAPHY(Point,4326)`, `GEOGRAPHY(MultiPolygon,4326)`,
  GIST indeksleri).
- **Redis** yalnızca türetilmiş/geçici veri: cache, rate limit sayaçları, distributed lock,
  sıcak availability verisi. Redis kaybı veri kaybı **olmamalı**.
- **Idempotency kalıcı veridir, Redis'te tutulmaz.** Yan etkili işlemlerin idempotency kaydı
  PostgreSQL'de `idempotency_keys` tablosunda, **yan etkiyle aynı transaction'da** yazılır:
  `key` (UNIQUE), `scope`, `request_fingerprint`, `response_snapshot`, `created_at`, `expires_at`.
  Redis yalnızca hızlı yol (ön kontrol) olabilir; doğruluk garantisi DB'dedir. Aynı key farklı
  istek gövdesiyle gelirse `IDEMPOTENCY_KEY_REUSED` döner. Redis flush'ı çift ödeme veya çift
  state geçişi üretemez.
  Aynı ilke event tüketiminde de geçerlidir: `processed_events` tablosu DB'de tutulur (ADR-0010).
- **Firestore** yalnızca chat/presence/geçici realtime state. Booking/payment/ledger yazılmaz.
- **BigQuery** yalnızca analitik; operasyonel okuma yolu değildir.
- **Cloud Storage** dosya içeriği; PostgreSQL `storage_key` + `sha256` + metadata tutar.

## Gerekçe

- Booking çakışma engeli, payment idempotency ve state geçişi + history yazımı tek transaction'da
  atomik olmalı. Bunu ancak tek ilişkisel DB verir.
- PostGIS, coğrafi filtrelemeyi uygulama katmanında yapmaya kıyasla candidate retrieval'ı
  bir büyüklük mertebesi hızlandırır ve doğru indekslenebilir.

## Sonuçlar

- Her tablo ve indeks versiyonlu migration ile gelir; elle DDL çalıştırılmaz.
- Yüksek hacimli `location_events` partitioning + retention gerektirir (Faz 8).
- Redis kullanan her kod yolu Redis yokken çalışmaya devam etmeli. Davranış kuralı:
  - **cache / sıcak veri:** degrade — doğrudan DB'den okunur.
  - **rate limiting:** fail-closed — sayaç tutulamıyorsa korumasız trafik kabul edilmez
    (istisna: panic flow, ADR-0008'e göre asla bloklanmaz).
  - **distributed lock:** DB constraint'in (ör. booking `EXCLUDE`) yeterli olduğu yerlerde lock
    bir **optimizasyondur**; Redis yoksa akış devam eder ve doğruluk DB tarafından korunur.
    Lock'un tek koruma olduğu bir yol varsa o yol fail-closed olur ve bu durum kodda gerekçelenir.
- Firestore kullanımı bir ADR ile gerekçelendirilmeden eklenmez.

## Alternatifler

- **Firestore primary (reddedildi):** transaction/ilişkisel sorgu sınırları, finansal tutarlılık riski, blueprint yasağı.
- **Ayrı geo servisi (reddedildi):** PostGIS yeterli; gereksiz bileşen.
