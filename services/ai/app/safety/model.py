"""Sapma tabanlı anomali modeli — ``anomaly-deviation-v1`` ve ``-v2``.

**Ne olduğu:** her türetilmiş sinyalin "olağan" davranıştan ne kadar saptığını
[0, 1] aralığında ölçen, parçalı doğrusal ve monoton sapma fonksiyonları ile
bunların *noisy-OR* birleşimi:

    skor = 1 − Π (1 − wᵢ · dᵢ)

**Ne olmadığı:** öğrenilmiş bir model değildir. Gerçek hizmet verisi yokken
(Faz 8) opak bir derin öğrenme modeli eğitmek mümkün de değil, savunulabilir de
değil. Referans aralıklar (``_Ramp``) açıkça yazılmış varsayımlardır; sürümle
birlikte değişir (ADR-0012) ve gerçek veri geldiğinde öğrenilmiş bir modelle
(ör. Isolation Forest) karşılaştırılacaktır (R-61).

**Neden kurallardan ayrı bir bileşen:** kurallar tek tek eşik geçişlerini yakalar.
Model ise eşiklerin **altında kalan birden fazla küçük sapmanın** birlikte
oluşturduğu tabloyu yakalar — ve kuralların kaçırdığı bu durum, deneyin (EXP-004)
ölçtüğü şeydir. Model tek başına karar veremez: core'da ``WARNING`` tavanı ve kalite
kapısı vardır.

**Kalite:** uygulanabilir özelliklerin ne kadarının gerçekten ölçülebildiği. Yarısı
eksik bir skor, core tarafında riske hiç girmez.

**Sürümler (ADR-0012):**

- ``v1`` — yalnızca **anlık** sinyaller. EXP-004, v1'in kendi amacını (kuralların
  eşiği altında kalan sapmaların birleşimi) yakalayamadığını gösterdi: sapmalar
  farklı anlarda olduğunda hiçbir anda birlikte görünmezler.
- ``v2`` — v1 + iki **oturum geçmişi** özelliği: son saatte tekrarlayan uzun
  boşluklar ve tekrarlayan geofence çıkışları. Tek olay olağandır (sapma 0); tekrar
  sapmadır. v1 karşılaştırma için kayıtlı kalır.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.safety.schema import AnomalyRequest, Contribution
from app.safety.versions import MODEL_V1, MODEL_V2, MODEL_VERSION, MODEL_VERSIONS

__all__ = ["MODEL_V1", "MODEL_V2", "MODEL_VERSION", "MODEL_VERSIONS", "assess"]


@dataclass(frozen=True)
class _Ramp:
    """``low``'da 0, ``high``'da 1 olan parçalı doğrusal sapma."""

    low: float
    high: float

    def __call__(self, value: float) -> float:
        if value <= self.low:
            return 0.0
        if value >= self.high:
            return 1.0
        return (value - self.low) / (self.high - self.low)


@dataclass(frozen=True)
class FeatureSpec:
    """Bir özelliğin ağırlığı ve olağan aralığı."""

    weight: float
    ramp: _Ramp


#: Özellik tanımları. Ağırlık < 1: tek bir özellik tam sapmada bile skoru 1'e
#: taşımaz. Değerler başlangıç varsayımlarıdır, deneyle bulunmuş değil (R-61).
FEATURES: dict[str, FeatureSpec] = {
    # Telemetri boşluğu, beklenen aralığın katı cinsinden: 6× (~3 dk) olağan,
    # 40× (~20 dk) tam sapma.
    "telemetry_gap": FeatureSpec(0.9, _Ramp(6.0, 40.0)),
    # Bütünlük retlerinin oranı: %2 olağan (tek kötü fix), %20 tam sapma.
    "integrity_rate": FeatureSpec(0.6, _Ramp(0.02, 0.20)),
    # Sahte konum oranı: herhangi bir sahte örnek sapmadır.
    "mock_rate": FeatureSpec(0.7, _Ramp(0.0, 0.05)),
    # --- Varış aşaması ---
    # Planlanan başlangıca göre gecikme (saniye): 5 dk olağan, 45 dk tam sapma.
    "arrival_delay": FeatureSpec(0.6, _Ramp(300.0, 2700.0)),
    # Hizmet noktasından uzaklaşma (metre, pencere içinde): 200 m olağan, 2 km tam.
    "moving_away": FeatureSpec(0.7, _Ramp(200.0, 2000.0)),
    # Rota tahminine göre öngörülen gecikme (saniye): 10 dk olağan, 45 dk tam.
    "projected_lateness": FeatureSpec(0.5, _Ramp(600.0, 2700.0)),
    # --- Hizmet aşaması ---
    # Geçen süre / planlanan süre: 1,15× olağan, 2× tam sapma.
    "duration_ratio": FeatureSpec(0.5, _Ramp(1.15, 2.0)),
    # Hizmet noktası dışında kalma süresi (saniye): 2 dk olağan, 20 dk tam.
    "outside_dwell": FeatureSpec(0.9, _Ramp(120.0, 1200.0)),
}

#: Oturum geçmişi özellikleri (yalnızca v2): son saatteki **tekrar** sayısı.
#: 1 olay olağandır (0), 3 olay tam sapmadır (1).
HISTORY_FEATURES: dict[str, FeatureSpec] = {
    "repeated_gaps": FeatureSpec(0.8, _Ramp(1.0, 3.0)),
    "repeated_exits": FeatureSpec(0.8, _Ramp(1.0, 3.0)),
}

#: Yolda takılma (yalnızca varış aşaması): hizmet noktasından uzakta, 30 dakikaya
#: normalize ilerlemenin **azlığı**. Hizmet sırasında hareketsizlik özelliği
#: **yoktur**: GPS bir dairenin içindeki hareketi göremez (kapalı alanda doğruluk
#: 20-60 m), bu yüzden o özellik her uzun işte sapma üretirdi (R-62).
STALLED_WEIGHT = 0.5

#: "Uzaklaşma" ve "yolda takılma" için gereken asgari gözlem penceresi (saniye).
#: Kısa pencere, kısa bir sapmayı eğilim gibi gösterirdi.
_MIN_TREND_WINDOW_SECONDS = 300
_MIN_STALL_WINDOW_SECONDS = 900
_STALL_REFERENCE_SECONDS = 1800
_STALL_FULL_METERS = 50.0
_STALL_NONE_METERS = 500.0
#: Hizmet noktasına bundan yakınken beklemek meşrudur (erken varış).
_STALL_MIN_DISTANCE_METERS = 1000


@dataclass(frozen=True)
class Assessment:
    score: float
    quality: float
    contributions: list[Contribution]
    unavailable: list[str]


def _stall_deviation(movement: float, window: float) -> float:
    """30 dakikaya normalize ilerleme azaldıkça artan sapma."""
    normalized = movement * (_STALL_REFERENCE_SECONDS / window)
    if normalized <= _STALL_FULL_METERS:
        return 1.0
    if normalized >= _STALL_NONE_METERS:
        return 0.0
    return 1.0 - (normalized - _STALL_FULL_METERS) / (_STALL_NONE_METERS - _STALL_FULL_METERS)


def _history(request: AnomalyRequest) -> tuple[dict[str, float], list[str]]:
    """v2 oturum geçmişi özellikleri."""
    deviations: dict[str, float] = {}
    unavailable: list[str] = []
    pairs: list[tuple[str, int | None]] = [("repeated_gaps", request.recent_long_gap_count)]
    # Varışta "çıkış" kavramı yoktur: özellik hiç eklenmez (0 olarak eklemek, her
    # zaman "ölçülmüş" bir özellikle kaliteyi yapay olarak şişirirdi).
    if request.session_status == "ACTIVE":
        pairs.append(("repeated_exits", request.recent_exit_count))
    for name, count in pairs:
        if count is None:
            unavailable.append(name)
        else:
            deviations[name] = HISTORY_FEATURES[name].ramp(float(count))
    return deviations, unavailable


def _weight(name: str) -> float:
    if name == "stalled":
        return STALLED_WEIGHT
    if name in HISTORY_FEATURES:
        return HISTORY_FEATURES[name].weight
    return FEATURES[name].weight


def _deviations(
    request: AnomalyRequest, eta_seconds: int | None
) -> tuple[dict[str, float], list[str]]:
    """Uygulanabilir özellikler için sapma; ölçülemeyenler ayrıca listelenir."""
    deviations: dict[str, float] = {}
    unavailable: list[str] = []

    def put(name: str, value: float | None) -> None:
        if value is None:
            unavailable.append(name)
        else:
            deviations[name] = FEATURES[name].ramp(value)

    # Her iki aşamada da uygulanabilir olanlar.
    put(
        "telemetry_gap",
        None
        if request.seconds_since_telemetry is None
        else request.seconds_since_telemetry / request.telemetry_interval_seconds,
    )
    attempts = request.telemetry_count + request.integrity_rejection_count
    put("integrity_rate", request.integrity_rejection_count / attempts if attempts > 0 else None)
    put(
        "mock_rate",
        request.mock_location_count / request.telemetry_count
        if request.telemetry_count > 0
        else None,
    )

    if request.session_status == "ARRIVAL_MONITORING":
        put(
            "arrival_delay",
            None if request.arrival_delay_seconds is None else float(request.arrival_delay_seconds),
        )
        trend_ok = (
            request.distance_trend_meters is not None
            and request.recent_window_seconds is not None
            and request.recent_window_seconds >= _MIN_TREND_WINDOW_SECONDS
        )
        put("moving_away", float(request.distance_trend_meters or 0) if trend_ok else None)
        put(
            "projected_lateness",
            None
            if eta_seconds is None or request.arrival_delay_seconds is None
            else float(request.arrival_delay_seconds + eta_seconds),
        )
        if (
            request.recent_movement_meters is None
            or request.recent_window_seconds is None
            or request.last_distance_meters is None
            or request.recent_window_seconds < _MIN_STALL_WINDOW_SECONDS
        ):
            unavailable.append("stalled")
        elif request.last_distance_meters < _STALL_MIN_DISTANCE_METERS:
            # Hizmet noktasının yakınında bekleme: sapma yok, eksik de değil.
            deviations["stalled"] = 0.0
        else:
            deviations["stalled"] = _stall_deviation(
                float(request.recent_movement_meters), float(request.recent_window_seconds)
            )
        return deviations, unavailable

    # Hizmet aşaması.
    put(
        "duration_ratio",
        None
        if request.elapsed_active_seconds is None
        else request.elapsed_active_seconds / request.planned_duration_seconds,
    )
    if request.geofence_state in ("INSIDE", "BOUNDARY"):
        # İçeride ya da sınırda: dışarıda kalma sapması yoktur (0), eksik değildir.
        deviations["outside_dwell"] = 0.0
    elif request.geofence_state == "OUTSIDE" and request.geofence_state_seconds is not None:
        deviations["outside_dwell"] = FEATURES["outside_dwell"].ramp(
            float(request.geofence_state_seconds)
        )
    else:
        # UNKNOWN / INSUFFICIENT_ACCURACY: "bilmiyoruz" — sapma değil, eksik sinyal.
        unavailable.append("outside_dwell")

    return deviations, unavailable


def assess(
    request: AnomalyRequest, eta_seconds: int | None, version: str = MODEL_VERSION
) -> Assessment:
    """Deterministik değerlendirme: aynı girdi ve sürüm her zaman aynı skoru verir."""
    if version not in MODEL_VERSIONS:
        raise ValueError(f"bilinmeyen model sürümü: {version}")
    deviations, unavailable = _deviations(request, eta_seconds)
    if version == MODEL_V2:
        extra, missing = _history(request)
        deviations.update(extra)
        unavailable.extend(missing)

    survival = 1.0
    contributions: list[Contribution] = []
    for name in sorted(deviations):
        weighted = _weight(name) * deviations[name]
        survival *= 1.0 - weighted
        contributions.append(
            Contribution(
                feature=name,
                deviation=round(deviations[name], 4),
                contribution=round(weighted, 4),
            )
        )

    applicable = len(deviations) + len(unavailable)
    quality = len(deviations) / applicable if applicable > 0 else 0.0

    # Katkılar büyükten küçüğe: operatör "neden" sorusunun cevabını ilk satırda görür.
    contributions.sort(key=lambda item: (-item.contribution, item.feature))

    return Assessment(
        score=round(1.0 - survival, 4),
        quality=round(quality, 4),
        contributions=contributions,
        unavailable=sorted(unavailable),
    )
