locals {
  name_prefix = "emek-${var.environment}"

  labels = merge(
    {
      app         = "emek"
      environment = var.environment
      managed_by  = "terraform"
    },
    var.labels,
  )

  # Topic listesi `services/api/src/common/events/event-topology.ts` ile aynı olmak
  # zorundadır. Ayrışırsa uygulama olmayan bir subscription'a abone olur ve hiçbir
  # event tüketmez — bu yüzden boot'ta subscription varlığı doğrulanır (Faz 13).
  event_topics = ["emek.booking", "emek.payment", "emek.safety", "emek.identity"]

  # Uygulamanın Secret Manager'dan okuduğu sırlar. **Değerleri burada yoktur**:
  # Terraform yalnızca kabı ve erişim iznini oluşturur, sürümü ayrı bir elden
  # (operatör veya sağlayıcı konsolu) gelir.
  # İstisna: `database-url` ve `redis-url` değerleri Terraform'un kendi ürettiği
  # kaynaklardan gelir (parola, AUTH dizesi, özel IP). Bunları düz env değişkeni
  # yapmak, kimlik bilgisini Cloud Run servis tanımında herkesin okuyabileceği bir
  # yere koyardı; bu yüzden onlar da Secret Manager'dan okunur.
  api_secret_ids = [
    "identity-callback-secret",
    "payment-webhook-secret",
    "storage-signing-secret",
    "ai-service-api-key",
    "database-url",
    "redis-url",
    "redis-ca-cert",
  ]

  # Değeri Terraform'un ürettiği sırlar — geri kalanının sürümü dışarıdan yazılır.
  terraform_managed_secret_ids = ["database-url", "redis-url", "redis-ca-cert"]
}
