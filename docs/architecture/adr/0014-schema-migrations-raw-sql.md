# ADR-0014 — Şema Ham SQL Migration'larla Yönetilir (ORM Şema DSL'i Yok)

- Durum: Accepted (2026-09-20)
- Faz: 1
- İlgili: ADR-0003, ADR-0004, ADR-0006

## Bağlam

Şema yönetimi için iki yaklaşım var: bir ORM'in şema DSL'i (TypeORM entity'leri, Prisma schema,
Drizzle schema) veya versiyonlu ham SQL migration'lar.

Emek'in veri modeli, ORM DSL'lerinin zayıf olduğu yapılara doğrudan bağımlı:

- `EXCLUDE USING GIST` constraint + predikat (booking çakışması — ADR-0006 §8)
- Kısmi (partial) unique index'ler (`WHERE identity_hash IS NOT NULL` — ADR-0004 §2)
- PostGIS tipleri ve GIST index'leri (`GEOGRAPHY(MultiPolygon,4326)`)
- Zaman bazlı partitioning + retention (`location_events` — ADR-0008 §5)
- Trigger'lar ve tablo bazlı rol/yetki ayrımı (`audit_logs` append-only — ADR-0013 §6)
- `CHECK` invariant'ları (`customer_id <> provider_id`)

## Karar

1. **Şema ham SQL ile, versiyonlu ve geri alınabilir migration'larla yönetilir.**
   Araç: `node-pg-migrate`. Migration dosyaları CommonJS `.js`, içinde `pgm.sql(...)` ile
   ham SQL bulunur — TS derleme adımı migration çalıştırmanın önkoşulu olmaz.
2. **Her migration `down` yönünü uygular** ve bu yön CI'da test edilir (`up → down → up`).
   Geri alınamayan bir adım varsa (veri dönüşümü) ayrı migration'a alınır ve nedeni yazılır.
3. **Elle DDL çalıştırılmaz.** Üretim şeması yalnızca migration ile değişir.
4. **Uygulama katmanı için ORM zorunlu değildir.** Faz 1'de doğrudan `pg` sürücüsü kullanılır.
   Sorgu katmanı kararı (tiplenmiş query builder mı, elle SQL mi) Faz 2'de repository'ler
   yazılırken verilir ve gerekiyorsa ayrı ADR olur. Bu karar **şema sahipliğini** değiştirmez:
   hangi sorgu aracı seçilirse seçilsin şema migration'larda kalır.
5. Extension'lar (`postgis`, `pgcrypto`) `down` yönünde düşürülmez: aynı veritabanını paylaşan
   başka objeler onlara bağlı olabilir ve `DROP EXTENSION` kolay geri alınamaz.

## Gerekçe

ORM DSL'i kullanılırsa yukarıdaki yapıların her biri zaten "raw SQL kaçış kapısı" ile yazılacaktı;
bu durumda şema iki yerden yönetilmiş olur (entity + raw blok) ve senkronizasyon hatası
kaçınılmaz hale gelir. Tek dilde (SQL) tek sahiplik daha az sürpriz üretir.

Ek olarak: ORM'in "otomatik senkronizasyon" özellikleri (synchronize/db push) transaction-yoğun
ve denetlenebilir olması gereken bir sistemde kabul edilemez — üretimde şema sessizce değişemez.

## Sonuçlar

- SQL bilgisi gerekli; şema değişikliği "entity'e alan ekle" kadar hızlı değil. Bu bilinçli bir
  yavaşlatmadır: şema değişikliği ucuz görünmemeli.
- Tip güvenliği otomatik gelmez. Faz 2'de repository katmanı, sorgu sonuçlarını açıkça tiplenmiş
  arayüzlere dönüştürür; tip ile şema arasındaki tutarlılık integration testleriyle korunur.
- `npm run migrate:up` / `migrate:down` scriptleri `.env` üzerinden çalışır; CI aynı komutları
  kullanır, böylece yerel ve CI davranışı ayrışmaz.

## Alternatifler

- **TypeORM/Prisma şema DSL'i (reddedildi):** yukarıdaki yapılar için yetersiz veya raw SQL'e
  düşüyor; iki sahiplik kaynağı doğuyor.
- **Elle SQL script'leri + kendi runner'ımız (reddedildi):** sürüm takibi, kilitleme ve
  geri alma mantığını yeniden yazmak gereksiz bakım yükü.
