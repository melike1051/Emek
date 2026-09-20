# ADR-0009 — Lisanslı Ödeme Kuruluşu + İdempotent Webhook

- Durum: Accepted (2026-09-20)
- Faz: 5
- Blueprint: §15, §24

## Bağlam

Şartlı ödeme (hizmet tamamlanana kadar tutma) marketplace güveninin temeli. Kendi escrow/emanet
yapısını kurmak Türkiye'de lisans gerektirir; teknik olarak da para hareketini kendi ledger'ında
tutmak yüksek risklidir.

## Karar

1. Emek **kendi escrow/ödeme kuruluşunu kurmaz.** Lisanslı ödeme kuruluşunun marketplace /
   alt üye işyeri / şartlı ödeme yetenekleri kullanılır.
2. Emek veritabanında yalnızca **referans ve durum** tutulur: `payments` (external payment id,
   tutar, currency, status) ve `payment_events` (external event id, tip, payload referansı).
   Kart verisi, PAN, CVV **hiçbir koşulda** Emek sistemine girmez; ödeme sayfası/SDK sağlayıcıya aittir.
3. Ödeme durumları: `CREATED → AUTHORIZED → HELD → SERVICE_COMPLETED → RELEASE_PENDING → RELEASED`;
   yan: `FAILED`, `REFUNDED`, `DISPUTED`, `AUTHORIZATION_EXPIRED`.
   **Sahiplik nettir:** booking aggregate root'tur, `payments.status` bir **projeksiyondur**
   (ADR-0006 §7). Çelişkide booking guard'ları belirleyicidir; payment durumu PSP event'lerinden
   mutabakatla düzeltilir. İki state machine'in "birlikte denetlenmesi" ifadesi yeterli değildir —
   tek yetkili kaynak booking'dir.
4. **Yetkilendirme süresi dolabilir.** Hold `CONFIRMED` anında alınır ve bu, `scheduled_start`'tan
   günler/haftalar önce olabilir; PSP yetkilendirmeleri tipik olarak birkaç gün geçerlidir.
   Bu nedenle:
   - `payments.authorization_expires_at` tutulur.
   - Süre dolmadan önce yeniden yetkilendirme (re-authorization) tetiklenir; başarısız olursa
     booking `SAFETY_HOLD` değil, tanımlı bir iptal/yeniden onay akışına girer.
   - Süre dolmuşsa release denenmez; `PAYMENT_AUTHORIZATION_EXPIRED` döner.
   - Bu senaryo test edilir (T-34).
5. **PSP'ye giden çağrılar da idempotenttir.** Outbound authorize/capture/refund çağrıları
   Emek tarafından üretilen bir idempotency key taşır. `external_event_id` UNIQUE yalnızca
   **gelen** webhook'ları tekilleştirir; giden çift çağrıyı engellemez.
6. **Ödeme yetkilendirme senkron tetiklenir**, event tüketiminden değil. At-least-once teslimli bir
   event'ten `authorize` çağırmak çift yetkilendirme riskidir (bkz. `event-catalog.md`).
7. **Webhook idempotency zorunlu:**
   - `payment_events.external_event_id` üzerinde UNIQUE constraint.
   - Webhook handler: imza doğrula → event'i INSERT etmeye çalış → çakışma varsa **hiçbir yan etki
     üretmeden 200 dön** → yeni ise aynı transaction'da durum geçişini uygula.
   - Aynı event iki kez geldiğinde para iki kez serbest bırakılamaz. Bu davranış test edilir.
   - Out-of-order event'ler için durum geçişi monotonluğu kontrol edilir (geri geçiş reddedilir).
8. Sağlayıcı bir **adapter** arkasındadır (`PaymentProvider` port: `createIntent`, `authorize`,
   `capture`/`release`, `refund`, `verifyWebhook`). Sandbox adapter ile Faz 5 geliştirilebilir;
   mock adapter production'da devre dışıdır ve seçilirse servis başlamaz.
9. `SAFETY_HOLD` veya açık `disputes` kaydı varken release **yapılamaz** (ADR-0006 guard'ı).
10. Settlement/payout mutabakatı için sağlayıcı raporu ile `payments` tablosu arasında düzenli
    reconciliation işi (Faz 11) — fark varsa alarm.

## Gerekçe

Lisans ve PCI kapsamı dışında kalmak hem hukuki hem teknik risk azaltır. Idempotency olmadan
webhook'lar kaçınılmaz olarak çift işlenir; ödeme domain'inde bu doğrudan finansal kayıptır.

## Sonuçlar

- Sağlayıcının marketplace/conditional payout yeteneği **doğrulanmalıdır** (risk R-02).
  Bu yetenek yoksa şartlı ödeme modeli yeniden tasarlanır.
- Webhook endpoint'i internetten erişilebilir: imza doğrulama, replay koruması, rate limit zorunlu.
- Test zorunlu: duplicate webhook (T-09), out-of-order event (T-10), dispute/SAFETY_HOLD'da
  release bloğu (T-11), yetkilendirme süresi dolmuşken release denemesi ve re-authorization (T-34).
- `payments.booking_id UNIQUE` kısmi iade veya çoklu intent senaryosunu kilitler; Faz 5'te
  `payment_intents` ayrımı değerlendirilir ve karar ADR olarak yazılır.

## Alternatifler

- **Kendi escrow (reddedildi):** lisans gereksinimi, blueprint yasağı.
- **Doğrudan kart saklama (reddedildi):** PCI-DSS kapsamı ve gereksiz risk.
