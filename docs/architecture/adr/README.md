# Architecture Decision Records

Her bağlayıcı mimari karar burada kayıtlıdır. Format: bağlam → karar → gerekçe → sonuçlar → alternatifler.

Bir ADR'yi değiştirmek için ADR silinmez: `Superseded by ADR-XXXX` olarak işaretlenir ve yeni ADR yazılır.

| # | Karar | Durum | Faz |
|---|---|---|---|
| [0001](0001-modular-monolith.md) | Modular monolith + ayrık AI/optimization servisleri | Accepted | 1 |
| [0002](0002-language-boundaries.md) | Core NestJS/TypeScript, AI Python — dil sınırı = domain sınırı | Accepted | 1 |
| [0003](0003-postgresql-source-of-truth.md) | PostgreSQL + PostGIS tek transactional source of truth | Accepted | 1 |
| [0004](0004-single-user-identity.md) | 1 insan = 1 User, DB seviyesinde tekil kimlik | Accepted | 3 |
| [0005](0005-identity-adapter.md) | Identity Verification Adapter Layer | Accepted | 3 |
| [0006](0006-booking-state-machine.md) | Merkezî booking state machine + history | Accepted | 4 |
| [0007](0007-llm-does-not-decide.md) | LLM talebi anlar, seçimi deterministik motor yapar | Accepted | 6-7 |
| [0008](0008-session-scoped-safety.md) | Hizmet oturumu bazlı safety telemetrisi, rules + ML hibriti | Accepted | 8 |
| [0009](0009-licensed-payment-provider.md) | Lisanslı ödeme kuruluşu + idempotent webhook | Accepted | 5 |
| [0010](0010-event-driven-pubsub.md) | Pub/Sub ile event-driven yan akışlar | Accepted | 9 |
| [0011](0011-backend-first.md) | Backend-first geliştirme, frontend Faz 15 | Accepted | 0 |
| [0012](0012-research-versioning.md) | Ar-Ge ölçülebilirliği veri modelinin parçası | Accepted | 6-8 |
| [0013](0013-authorization-and-audit-integrity.md) | Yetkilendirme modeli ve audit bütünlüğü | Accepted | 2, 12 |
