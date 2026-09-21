"""EXP-004 toplu skorlayıcı: `uv run python -m app.evaluation.safety.score`.

Girdi (stdin): ``AnomalyRequest`` nesnelerinden oluşan JSON dizisi — core'daki
EXP-004 harness'inin, üretimdeki **aynı** özellik fonksiyonuyla ürettiği girdiler.
Çıktı (stdout): aynı sırada ``AnomalyResponse`` dizisi.

Endpoint ile aynı kod yolu kullanılır (``app.safety.service.assess`` + yapılandırılmış
rota sağlayıcısı); HTTP katmanı atlanır çünkü on binlerce değerlendirme için ağ
gidiş-dönüşü ölçülen şeye hiçbir şey katmaz. Deney yalnızca model davranışını ölçer.
"""

from __future__ import annotations

import json
import sys

from pydantic import TypeAdapter

from app.config import get_settings
from app.routing.registry import get_router
from app.safety import service
from app.safety.schema import AnomalyRequest

_REQUESTS = TypeAdapter(list[AnomalyRequest])


def score(raw: str, model_version: str | None = None) -> str:
    settings = get_settings()
    version = model_version or settings.anomaly_model_version
    router = get_router(settings.routing_provider)
    requests = _REQUESTS.validate_json(raw)
    responses = [
        service.assess(request, router, version).model_dump(mode="json") for request in requests
    ]
    return json.dumps(responses, ensure_ascii=False)


def main() -> int:
    # İsteğe bağlı ilk argüman: model sürümü (EXP-004 v1/v2 karşılaştırması).
    version = sys.argv[1] if len(sys.argv) > 1 else None
    sys.stdout.write(score(sys.stdin.read(), version))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
