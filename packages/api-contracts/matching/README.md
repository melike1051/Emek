# Matching servis sözleşmesi fixture'ları

Bu dizindeki iki dosya, core (NestJS) ile AI servisi (FastAPI) arasındaki
`POST /api/v1/matching/solve` çağrısının **gerçek** örnekleridir:

| Dosya                 | Nedir                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `solve-request.json`  | `HttpMatchingClient`'in ürettiği gövde (yakalanmıştır, elle yazılmamıştır) |
| `solve-response.json` | AI servisinin o gövdeye verdiği yanıt                                      |

## Neden var

İki servis ayrı CI işlerinde koşuyor ve hiçbir test ikisini birlikte ayağa
kaldırmıyor. Alan adlandırmasında (snake_case ↔ camelCase) veya bir alanın tipinde
sessiz bir sapma, üretimde **bozulmuş moda düşmek** olarak görünür: core her çağrıda
`INVALID_RESPONSE` alır, kendi yedek sıralamasına düşer ve **hiçbir test kırılmaz**.
Kullanıcı yalnızca daha kötü eşleşmeler görür — sessiz bir kalite kaybı.

Her iki taraf da bu dosyalara karşı test edilir:

- core: `services/api/src/matching/matching-contract.spec.ts`
- AI: `services/ai/tests/test_matching_contract.py`

## Ne zaman yenilenir

Fixture'lar **karar da içerir** (sıralama ve atama). AI tarafındaki
`test_fixture_response_matches_what_the_engine_produces_today` testi, aynı girdinin
bugün de aynı kararı verdiğini doğrular. Kırılırsa iki seçenek vardır:

1. Karar bilinçli olarak değişti → sürüm etiketi artırılır (`algorithm_version`,
   `weights_version` veya `objective_version`) **ve** fixture yenilenir.
2. Karar istemeden değişti → hata düzeltilir.

Sessizce fixture yenilemek üçüncü bir seçenek değildir: sözleşmeyi anlamsız kılar.

## Yenileme

AI servisi ayakta olmalıdır (`cd services/ai && uv run fastapi dev app/main.py`).
Fixture'lar gerçek bir çağrıdan yakalanır — elle düzenlenmez.
