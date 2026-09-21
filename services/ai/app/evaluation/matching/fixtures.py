"""Sentetik matching senaryoları (ADR-0012 §4).

**Bu veri gerçek değildir ve öyle raporlanmaz.** Gerçek kullanıcı talebi, gerçek
sağlayıcı ve gerçek kabul davranışı Faz 15-16'dan önce yoktur; o veri olmadan
matching'i ölçmenin tek dürüst yolu, üretim sürecini taklit eden **açıkça
etiketlenmiş** bir üreteçtir.

Üretecin en kritik tasarım kararı **gizli gerçek** (hidden ground truth) ile
**gözlenebilir özellik** ayrımıdır:

- Her sağlayıcının, algoritmanın hiç görmediği gizli nitelikleri vardır
  (`reliability`, `affinity`). "Doğru eşleşme" bu gizli niteliklerden hesaplanır.
- Algoritmanın gördüğü alanlar (puan, kalite skoru, yetkinlik seviyesi) bu gizli
  niteliklerin **gürültülü yansımalarıdır**.

Bu ayrım olmasaydı Recall@K döngüsel olurdu: "doğru sağlayıcı" skor fonksiyonunun
kendisiyle tanımlanır, proposed her zaman 1.0 alır ve ölçüm hiçbir şey söylemezdi.
Gizli gerçek, skor fonksiyonundan **farklı bir işlevsel biçime** sahiptir ve
algoritmanın erişemediği değişkenler içerir; bu yüzden Recall@K < 1.0 olabilir ve
anlamlıdır.

Sınır (R-45 ile aynı sınıf): üreteç ile skor fonksiyonu aynı fazda yazıldı. Gizli
gerçek ile gözlenebilir özellikler arasındaki ilişki **varsayımdır**; gerçek
dünyada daha zayıf da olabilir. Sonuçlar bu sınırla birlikte raporlanır.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import get_args
from uuid import UUID, uuid5

from app.matching.schema import (
    BookingDemand,
    CandidateFeatures,
    Interval,
    Location,
    SkillLevel,
)
from app.nlp.schema import Requirement, ServiceType

#: Sentetik kimlikleri türetmek için sabit ad alanı: aynı tohum → aynı UUID'ler.
_NAMESPACE = UUID("6f0f5a3e-1f23-4c9f-9f2b-0f0d0a1b2c3d")

#: Senaryo merkezi (İstanbul Kadıköy civarı). Gerçek bir adres değil, yalnızca
#: koordinatların makul bir yoğunlukta dağılması için referans nokta.
_CENTER = Location(latitude=40.9900, longitude=29.0300)

#: Merkez etrafındaki yayılma (derece). ~0.09° ≈ 10 km enlemde.
_SPREAD_DEGREES = 0.09

#: Bir derece enlemin metre karşılığı — sentetik mesafe hesabı için yeterli.
_METERS_PER_DEGREE = 111_320.0

# `get_args`, Literal kümesini tipiyle birlikte verir: slug listesini elle
# tekrarlamak, şema ile üretecin sessizce ayrışması demekti.
_SKILLS: tuple[Requirement, ...] = get_args(Requirement)
_SERVICES: tuple[ServiceType, ...] = get_args(ServiceType)


@dataclass(frozen=True)
class HiddenProvider:
    """Sağlayıcının **gizli** nitelikleri. Algoritma bunları hiç görmez."""

    provider_id: UUID
    reliability: float
    affinity: dict[ServiceType, float]
    home: Location
    #: Sağlayıcının kendi beyan ettiği hizmet yarıçapı (metre).
    service_radius_meters: int
    max_daily_bookings: int
    #: Gözlenebilir alanlar — gizli niteliklerin gürültülü yansımaları.
    verified: bool
    verified_skills: tuple[Requirement, ...]
    skill_levels: dict[Requirement, SkillLevel]
    rating_avg: float | None
    rating_count: int
    quality_score: float
    completed_bookings: int
    availability: tuple[Interval, ...]
    daily_booking_count: int


@dataclass(frozen=True)
class Scenario:
    """Tek bir değerlendirme senaryosu."""

    name: str
    seed: int
    demands: tuple[BookingDemand, ...]
    providers: dict[UUID, HiddenProvider]
    #: Talep → gizli gerçeğe göre en iyi **uygun** sağlayıcı. Uygun aday yoksa yok.
    ground_truth: dict[UUID, UUID]
    max_distance_meters: int


def _distance_meters(first: Location, second: Location) -> int:
    """Düzlemsel yaklaşık mesafe.

    Sentetik veride küçük bir bölge kullanıldığı için düzlem yaklaşımı yeterlidir;
    üretimdeki mesafe PostGIS `geography` ile ölçülür, burada değil.
    """
    import math

    mean_lat = math.radians((first.latitude + second.latitude) / 2)
    delta_lat = (second.latitude - first.latitude) * _METERS_PER_DEGREE
    delta_lon = (second.longitude - first.longitude) * _METERS_PER_DEGREE * math.cos(mean_lat)
    return round(math.hypot(delta_lat, delta_lon))


def true_fit(
    provider: HiddenProvider,
    demand: BookingDemand,
    *,
    max_distance_meters: int,
) -> float:
    """Gizli gerçek uyum skoru.

    Skor fonksiyonundan bilinçli olarak farklıdır: bileşenleri (gizli güvenilirlik,
    hizmet yatkınlığı) algoritmanın göremediği değişkenlerdir ve ağırlıkları
    `weights-v1` ile aynı değildir. Yetkinlik/müsaitlik burada yoktur — onlar
    uygunluk (hard constraint) sorusudur, kalite sorusu değil.
    """
    affinity = provider.affinity.get(demand.service_type, 0.0)
    travel_burden = min(1.0, _distance_meters(provider.home, demand.location) / max_distance_meters)
    return round(0.45 * affinity + 0.30 * provider.reliability + 0.25 * (1.0 - travel_burden), 6)


def acceptance(
    provider: HiddenProvider,
    demand: BookingDemand,
    scheduled_start: datetime,
    *,
    max_distance_meters: int,
    timezone_offset_hours: int = 3,
) -> bool:
    """Sağlayıcının teklifi kabul edip etmeyeceği — **simüle edilmiş** davranış.

    Gerçek kabul verisi yoktur (research-metrics §2.2 "acceptance rate" üretimde
    ölçülecek). Bu model bir yer tutucudur ve iki özelliği vardır:

    1. **Deterministiktir**: aynı teklif her zaman aynı yanıtı alır. Rastgele olsaydı
       iki algoritma kolunu karşılaştırmak, algoritmayı değil zar atışını ölçerdi.
    2. **Teklifin kendisine bağlıdır**: yol yükü ve saat uygunluğu. Böylece daha
       yakın ve daha uygun saatli teklif üreten bir algoritma ödüllendirilir.

    Mutlak bir kabul oranı iddiası **taşımaz**; yalnızca kollar arası karşılaştırma
    için anlamlıdır.
    """
    travel_burden = min(1.0, _distance_meters(provider.home, demand.location) / max_distance_meters)
    local_hour = (scheduled_start.hour + timezone_offset_hours) % 24
    # Çok erken/çok geç saatler cazip değildir.
    hour_penalty = 0.0 if 8 <= local_hour <= 18 else 0.25

    willingness = (
        0.6 * true_fit(provider, demand, max_distance_meters=max_distance_meters)
        + 0.4 * (1.0 - travel_burden)
        - hour_penalty
    )
    return willingness >= 0.55


def _make_provider(
    rng: random.Random,
    index: int,
    day_start: datetime,
    days: int,
) -> HiddenProvider:
    provider_id = uuid5(_NAMESPACE, f"provider-{index}")

    reliability = rng.betavariate(5, 2)
    affinity = {service: rng.betavariate(2, 2) for service in _SERVICES}

    home = Location(
        latitude=_CENTER.latitude + rng.uniform(-_SPREAD_DEGREES, _SPREAD_DEGREES),
        longitude=_CENTER.longitude + rng.uniform(-_SPREAD_DEGREES, _SPREAD_DEGREES),
    )

    # Gözlenebilir puan: güvenilirlik ve ortalama yatkınlığın gürültülü yansıması.
    mean_affinity = sum(affinity.values()) / len(affinity)
    latent_quality = 0.7 * reliability + 0.3 * mean_affinity
    noisy = min(1.0, max(0.0, latent_quality + rng.gauss(0.0, 0.10)))

    rating_count = rng.choice((0, 0, 1, 3, 7, 15, 40, 120))
    rating_avg = None if rating_count == 0 else round(min(5.0, max(1.0, 1.0 + 4.0 * noisy)), 2)

    skill_count = rng.randint(1, 4)
    verified_skills = tuple(sorted(rng.sample(_SKILLS, skill_count)))
    # Seviye, gizli güvenilirlikten türetilir: gözlenebilir seviye de gizli
    # niteliğin bir yansımasıdır, bağımsız bir bilgi değil.
    level = (
        SkillLevel.EXPERT
        if reliability > 0.80
        else SkillLevel.INTERMEDIATE
        if reliability > 0.55
        else SkillLevel.BEGINNER
    )
    skill_levels = dict.fromkeys(verified_skills, level)

    # Müsaitlik: her gün için tek bir çalışma penceresi; başlangıç saati değişir.
    availability: list[Interval] = []
    for day in range(days):
        if rng.random() < 0.15:
            # Sağlayıcıların bir kısmı her gün çalışmaz.
            continue
        start_hour = rng.choice((6, 7, 8, 9))
        length = rng.choice((8, 9, 10, 12))
        start = day_start + timedelta(days=day, hours=start_hour)
        availability.append(Interval(start=start, end=start + timedelta(hours=length)))

    return HiddenProvider(
        provider_id=provider_id,
        reliability=round(reliability, 6),
        affinity={service: round(value, 6) for service, value in affinity.items()},
        home=home,
        service_radius_meters=rng.choice((8_000, 15_000, 25_000, 40_000)),
        max_daily_bookings=rng.choice((1, 2, 2, 3)),
        verified=rng.random() > 0.10,
        verified_skills=verified_skills,
        skill_levels=skill_levels,
        rating_avg=rating_avg,
        rating_count=rating_count,
        quality_score=round(noisy, 4),
        completed_bookings=rating_count * rng.randint(1, 3),
        availability=tuple(availability),
        daily_booking_count=0,
    )


def _features_for(
    provider: HiddenProvider,
    demand_location: Location,
    service_type: ServiceType,
    *,
    offers_everything: bool,
) -> CandidateFeatures:
    distance = _distance_meters(provider.home, demand_location)
    return CandidateFeatures(
        provider_id=provider.provider_id,
        verified=provider.verified,
        # Sentetik katalogda her sağlayıcı, yatkınlığı bir eşiğin üstündeyse hizmeti sunar.
        offers_service=offers_everything or provider.affinity.get(service_type, 0.0) > 0.2,
        verified_skills=provider.verified_skills,
        availability=provider.availability,
        has_conflicting_booking=False,
        within_service_area=distance <= provider.service_radius_meters,
        distance_meters=distance,
        daily_booking_count=provider.daily_booking_count,
        max_daily_bookings=provider.max_daily_bookings,
        skill_levels=provider.skill_levels,
        rating_avg=provider.rating_avg,
        rating_count=provider.rating_count,
        quality_score=provider.quality_score,
        completed_bookings=provider.completed_bookings,
        home_location=provider.home,
    )


def build_scenario(
    *,
    name: str,
    seed: int,
    provider_count: int,
    demand_count: int,
    day_start: datetime,
    days: int = 1,
    max_distance_meters: int = 50_000,
    candidates_per_demand: int = 20,
) -> Scenario:
    """Tohumdan senaryo üretir. Aynı tohum → aynı senaryo (yeniden üretilebilirlik)."""
    rng = random.Random(seed)  # noqa: S311 - kriptografik amaç yok, yeniden üretilebilirlik var

    providers = [_make_provider(rng, index, day_start, days) for index in range(provider_count)]
    provider_index = {provider.provider_id: provider for provider in providers}

    demands: list[BookingDemand] = []
    ground_truth: dict[UUID, UUID] = {}

    for index in range(demand_count):
        request_id = uuid5(_NAMESPACE, f"{name}-request-{index}")
        service_type = rng.choice(_SERVICES)
        duration = rng.choice((120, 180, 240, 300))
        day = rng.randrange(days)
        window_start_hour = rng.choice((8, 9, 10, 12))
        window_length = rng.choice((6, 8, 10))
        window = Interval(
            start=day_start + timedelta(days=day, hours=window_start_hour),
            end=day_start + timedelta(days=day, hours=window_start_hour + window_length),
        )
        location = Location(
            latitude=_CENTER.latitude + rng.uniform(-_SPREAD_DEGREES, _SPREAD_DEGREES),
            longitude=_CENTER.longitude + rng.uniform(-_SPREAD_DEGREES, _SPREAD_DEGREES),
        )
        required = tuple(sorted(rng.sample(_SKILLS, rng.randint(0, 2))))
        sampled = rng.sample(_SKILLS, rng.randint(0, 2))
        preferred = tuple(sorted(skill for skill in sampled if skill not in required))

        # Aday havuzu: core'un PostGIS ile getireceği havuzu taklit eder — en yakın N.
        nearest = sorted(
            providers,
            key=lambda provider: (
                _distance_meters(provider.home, location),
                str(provider.provider_id),
            ),
        )[:candidates_per_demand]

        demand = BookingDemand(
            request_id=request_id,
            service_type=service_type,
            duration_minutes=duration,
            window=window,
            location=location,
            required_skills=required,
            preferred_skills=preferred,
            candidates=tuple(
                _features_for(provider, location, service_type, offers_everything=False)
                for provider in nearest
            ),
        )
        demands.append(demand)

        best = _best_by_truth(demand, provider_index, max_distance_meters=max_distance_meters)
        if best is not None:
            ground_truth[request_id] = best

    return Scenario(
        name=name,
        seed=seed,
        demands=tuple(demands),
        providers=provider_index,
        ground_truth=ground_truth,
        max_distance_meters=max_distance_meters,
    )


def _best_by_truth(
    demand: BookingDemand,
    providers: dict[UUID, HiddenProvider],
    *,
    max_distance_meters: int,
) -> UUID | None:
    """Gizli gerçeğe göre en iyi **uygun** sağlayıcı.

    Uygunluk, hard constraint değerlendirmesinin kendisidir: uygun olmayan bir
    sağlayıcı "doğru cevap" olamaz, çünkü sisteme atanması zaten yasaktır.
    """
    from app.matching.constraints import evaluate

    ranked: list[tuple[float, str, UUID]] = []
    for candidate in demand.candidates:
        if evaluate(demand, candidate, max_distance_meters=max_distance_meters):
            continue
        provider = providers[candidate.provider_id]
        fit = true_fit(provider, demand, max_distance_meters=max_distance_meters)
        ranked.append((-fit, str(candidate.provider_id), candidate.provider_id))

    if not ranked:
        return None

    ranked.sort(key=lambda item: (item[0], item[1]))
    return ranked[0][2]
