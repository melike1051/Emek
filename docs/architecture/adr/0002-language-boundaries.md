# ADR-0002 — Dil Sınırı = Domain Sınırı (NestJS core, Python AI)

- Durum: Accepted (2026-09-20)
- Faz: 1
- Blueprint: §2, §5, §25

## Bağlam

Projede iki farklı yetkinlik alanı var: transaction-yoğun marketplace business logic ve
NLP/ML/kombinatoryal optimizasyon. Her ikisini tek dilde yazmak mümkün ama her iki yönde de bedelli.

## Karar

- **NestJS + TypeScript**: auth, users, providers, customers, services, skills, availability,
  bookings, payments, verification, safety (orchestration), location, reviews, disputes,
  notifications, admin, audit. Tüm DB yazma işlemleri ve state geçişleri burada.
- **Python + FastAPI**: NLP/structured extraction, scoring, OR-Tools optimization, anomaly detection.
  Karar üretir, **core domain state'i yazmaz**.
- Python servisi PostgreSQL'e yalnızca okuma amaçlı (candidate retrieval için) erişir; yazma
  yetkisi olan DB rolü verilmez. Sonuçlar NestJS'e HTTP response veya event olarak döner ve
  persist etme sorumluluğu NestJS'tedir.

## Gerekçe

- TypeScript web/backend arasında tip paylaşımı sağlar (`packages/shared-types`).
- Python'un NLP/ML/OR-Tools ekosistemi TypeScript'te karşılığı olmayan bir avantaj.
- Yazma yetkisinin tek dilde olması audit, transaction ve state machine bütünlüğünü korur:
  iki farklı servis aynı tabloya yazarsa invariant'ları tek yerde zorlamak imkânsızlaşır.

## Sonuçlar

- İki toolchain (npm workspaces + uv), iki test runner (jest/vitest + pytest), iki Docker image.
- Servisler arası sözleşme `packages/api-contracts` altında şema olarak tutulur; her iki tarafta
  contract test zorunlu (Faz 6-7).
- AI servisi timeout/hata verdiğinde core akış **graceful degrade** etmeli (baseline scoring fallback).
  Bu davranış test edilir (bkz. test-strategy "optimization timeout").

## Alternatifler

- **Her şey Python (reddedildi):** blueprint §24 yasaklıyor; TS tip paylaşımı ve NestJS modülerliği kaybedilir.
- **Her şey TypeScript (reddedildi):** OR-Tools ve NLP ekosistemi yok; Ar-Ge hızı düşer.
- **AI'a yazma yetkisi vermek (reddedildi):** state machine ve audit invariant'ları bölünür.
