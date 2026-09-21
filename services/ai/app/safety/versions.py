"""Anomali modeli sürüm kaydı.

Ayrı modüldür: yapılandırma (``app.config``) sürümü doğrulamak için bunu okur;
model koduna (ve dolayısıyla domain bağımlılıklarına) bağlanmaz.
"""

MODEL_V1 = "anomaly-deviation-v1"
MODEL_V2 = "anomaly-deviation-v2"
#: Kayıtlı sürümler; varsayılan en günceldir.
MODEL_VERSIONS: tuple[str, ...] = (MODEL_V1, MODEL_V2)
MODEL_VERSION = MODEL_V2
