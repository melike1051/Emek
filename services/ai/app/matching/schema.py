"""Matching sözleşmesi: core ↔ AI servisi (ADR-0002, ADR-0007).

Bu şema iki şeyi aynı anda yapar:

1. **Sınır çizer.** AI servisi veritabanına yazmaz ve kendi başına aday da üretmez:
   adaylar core tarafından PostGIS/SQL ile getirilir ve **özellik vektörü** olarak
   buraya taşınır. Servis yalnızca "bu adaylardan hangisi, ne zaman" sorusunu yanıtlar.
2. **Güvenlik sınırı olur.** NLP şemasıyla aynı ilke: serbest metin alanı yoktur.
   Yetkinlik ve hizmet türü kapalı kümelerdir (katalog slug'ları), sayısal alanlar
   aralıklıdır. Böylece kullanıcı metni buraya komut olarak sızamaz.

Kişisel veri taşınmaz: ad, telefon, adres satırı gibi alanlar yoktur. Sağlayıcı
kimliği bir UUID'dir; konum, karar için gereken **koordinattır**, adres değil.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.nlp.schema import Requirement, ServiceType

#: Hizmetin en kısa/en uzun süresi — `StructuredRequest` ile aynı sınırlar.
MIN_DURATION_MINUTES = 30
MAX_DURATION_MINUTES = 1440

#: Mutlak tavan değerler.
#:
#: Yapılandırılabilir sınırlar (`optimization_max_bookings`,
#: `optimization_max_candidates_per_booking`) uç noktada uygulanır; buradakiler
#: onların **üstündeki** sözleşme tavanıdır. İkisi birden gerekli: yapılandırma
#: yanlış ayarlanabilir, şema tavanı ayarlanamaz. Tavansız bir sözleşme, çağıranın
#: iyi niyetine güvenmek demekti — ve CP-SAT model kurulumu zaman limitinden
#: **önce** çalışır, yani çözücü limiti bu yükü sınırlamaz (R-16).
MAX_DEMANDS_PER_REQUEST = 500
MAX_CANDIDATES_PER_DEMAND = 500


class SkillLevel(StrEnum):
    """`provider_skills.level` ile birebir aynı küme."""

    BEGINNER = "BEGINNER"
    INTERMEDIATE = "INTERMEDIATE"
    EXPERT = "EXPERT"


class Location(BaseModel):
    """WGS84 koordinatı."""

    model_config = ConfigDict(frozen=True)

    latitude: float = Field(ge=-90.0, le=90.0)
    longitude: float = Field(ge=-180.0, le=180.0)


class Interval(BaseModel):
    """Yarı açık zaman aralığı `[start, end)` — `tstzrange` ile aynı semantik."""

    model_config = ConfigDict(frozen=True)

    start: datetime
    end: datetime

    @model_validator(mode="after")
    def _ordered_and_aware(self) -> Interval:
        if self.start.tzinfo is None or self.end.tzinfo is None:
            # Naif bir damga "hangi saat dilimi" sorusunu çağırana bırakır; iki
            # servis farklı yorumlarsa randevu saatleri sessizce kayar.
            raise ValueError("zaman damgaları saat dilimi taşımak zorunda")
        if self.end <= self.start:
            raise ValueError("end, start'tan büyük olmalı")
        return self

    @property
    def minutes(self) -> int:
        return int((self.end - self.start).total_seconds() // 60)

    def overlap_minutes(self, other: Interval) -> int:
        """İki aralığın kesişimi (dakika); kesişmiyorsa 0."""
        start = max(self.start, other.start)
        end = min(self.end, other.end)
        if end <= start:
            return 0
        return int((end - start).total_seconds() // 60)

    def intersect(self, other: Interval) -> Interval | None:
        start = max(self.start, other.start)
        end = min(self.end, other.end)
        if end <= start:
            return None
        return Interval(start=start, end=end)

    def contains(self, other: Interval) -> bool:
        return self.start <= other.start and other.end <= self.end

    def shifted_end(self, minutes: int) -> Interval:
        return Interval(start=self.start, end=self.start + timedelta(minutes=minutes))


class CandidateFeatures(BaseModel):
    """Bir sağlayıcının, **bu talep için** hesaplanmış özellikleri.

    Alanlar iki gruba ayrılır ve karışmamaları önemlidir:

    - **Hard constraint girdileri** (`verified`, `offers_service`, `verified_skills`,
      `availability`, `has_conflicting_booking`, `within_service_area`,
      `distance_meters`, kapasite): ihlal varsa aday **elenir**, hiçbir skor telafi
      etmez (ADR-0007 §4).
    - **Scoring girdileri** (`skill_levels`, `rating_*`, `quality_score`,
      `completed_bookings`): yalnızca sıralamayı etkiler.

    Core bu alanları SQL'de hesaplar; AI servisi kısıtları **yeniden** değerlendirir.
    Tek taraflı güven, iki servis sürümü ayrıştığında ihlalli bir adayın sıralamaya
    girmesi demektir.
    """

    model_config = ConfigDict(frozen=True)

    provider_id: UUID

    # --- hard constraint girdileri ---
    verified: bool
    offers_service: bool
    verified_skills: tuple[Requirement, ...] = ()
    availability: tuple[Interval, ...] = ()
    has_conflicting_booking: bool = False
    within_service_area: bool = True
    distance_meters: int = Field(ge=0)
    daily_booking_count: int = Field(ge=0)
    max_daily_bookings: int = Field(ge=1, le=10)

    # --- scoring girdileri ---
    skill_levels: dict[Requirement, SkillLevel] = Field(default_factory=dict)
    rating_avg: float | None = Field(default=None, ge=1.0, le=5.0)
    rating_count: int = Field(default=0, ge=0)
    quality_score: float | None = Field(default=None, ge=0.0, le=1.0)
    completed_bookings: int = Field(default=0, ge=0)
    #: Sağlayıcının hizmet bölgelerinin ağırlık merkezi — optimizasyonda rota başlangıcı.
    home_location: Location | None = None

    @model_validator(mode="after")
    def _rating_pair_is_consistent(self) -> CandidateFeatures:
        # `provider_profiles` CHECK'i ile aynı invariant: ortalama ve sayaç birbirini tutar.
        if (self.rating_avg is None) != (self.rating_count == 0):
            raise ValueError("rating_avg ile rating_count tutarsız")
        return self

    @model_validator(mode="after")
    def _skill_levels_cover_verified_skills(self) -> CandidateFeatures:
        missing = set(self.verified_skills) - set(self.skill_levels)
        if missing:
            raise ValueError(f"seviye bilgisi eksik yetkinlik: {sorted(missing)}")
        return self


class BookingDemand(BaseModel):
    """Eşleştirilecek tek bir talep."""

    model_config = ConfigDict(frozen=True)

    request_id: UUID
    service_type: ServiceType
    duration_minutes: int = Field(ge=MIN_DURATION_MINUTES, le=MAX_DURATION_MINUTES)
    window: Interval
    location: Location
    #: Hard constraint: bu yetkinliklerin **doğrulanmış** olarak bulunması zorunlu.
    required_skills: tuple[Requirement, ...] = ()
    #: Soft constraint: kapalı slug kümesi (Faz 6 review bulgusu M2). Eksikliği eler değil,
    #: yalnızca skoru düşürür.
    preferred_skills: tuple[Requirement, ...] = ()
    candidates: tuple[CandidateFeatures, ...] = Field(
        default=(), max_length=MAX_CANDIDATES_PER_DEMAND
    )

    @model_validator(mode="after")
    def _window_fits_duration(self) -> BookingDemand:
        if self.window.minutes < self.duration_minutes:
            raise ValueError("talep penceresi istenen süreyi kapsamıyor")
        return self

    @model_validator(mode="after")
    def _no_duplicate_skills(self) -> BookingDemand:
        for name, values in (
            ("required_skills", self.required_skills),
            ("preferred_skills", self.preferred_skills),
        ):
            if len(set(values)) != len(values):
                raise ValueError(f"{name} tekrar içeremez")
        return self

    @model_validator(mode="after")
    def _unique_candidates(self) -> BookingDemand:
        ids = [candidate.provider_id for candidate in self.candidates]
        if len(set(ids)) != len(ids):
            raise ValueError("aynı sağlayıcı iki kez aday olamaz")
        return self


class SolveRequest(BaseModel):
    """Bir veya daha fazla talebin **birlikte** çözülmesi.

    Tek talep de bu yoldan geçer: ayrı bir "tek talep" kod yolu açmak, iki yolun
    zamanla farklı davranması demektir. Birden fazla talep verildiğinde atama
    küresel olarak yapılır — sırayla "en yüksek skor kazanır" değil (ADR-0007 §5).
    """

    model_config = ConfigDict(frozen=True)

    demands: tuple[BookingDemand, ...] = Field(min_length=1, max_length=MAX_DEMANDS_PER_REQUEST)
    #: `False` ise yalnızca sıralama üretilir; optimizasyon çalıştırılmaz.
    optimize: bool = True
    #: Mutlak mesafe üst sınırı (metre). **Çağıran belirler.**
    #:
    #: İki serviste ayrı ayrı yapılandırılsaydı ("aynı değeri taşımalıdır" notuyla)
    #: sapma sessiz olurdu: eleme core'un değerine, `distance_score` motorun değerine
    #: göre hesaplanır ve saklanan her skor bileşeni fark ettirmeden bozulurdu.
    #: Değer istekle birlikte taşınınca sapma imkânsız hâle gelir.
    #: Verilmezse servis kendi varsayılanını kullanır (benchmark ve elle çağrı için).
    max_distance_meters: int | None = Field(default=None, ge=1_000, le=500_000)

    @model_validator(mode="after")
    def _unique_requests(self) -> SolveRequest:
        ids = [demand.request_id for demand in self.demands]
        if len(set(ids)) != len(ids):
            raise ValueError("aynı talep iki kez gönderilemez")
        return self


class ConstraintCode(StrEnum):
    """Hard constraint ihlal nedenleri. Kapalı küme: rapor ve alarmlar buna dayanır."""

    PROVIDER_NOT_VERIFIED = "PROVIDER_NOT_VERIFIED"
    SERVICE_NOT_OFFERED = "SERVICE_NOT_OFFERED"
    MISSING_REQUIRED_SKILL = "MISSING_REQUIRED_SKILL"
    NOT_AVAILABLE = "NOT_AVAILABLE"
    BOOKING_CONFLICT = "BOOKING_CONFLICT"
    OUTSIDE_SERVICE_AREA = "OUTSIDE_SERVICE_AREA"
    DISTANCE_LIMIT_EXCEEDED = "DISTANCE_LIMIT_EXCEEDED"
    CAPACITY_EXCEEDED = "CAPACITY_EXCEEDED"


class ExplanationCode(StrEnum):
    """Açıklama gerekçeleri (ADR-0007 §6).

    Açıklama metni **saklanan skor bileşenlerinden** üretilir; modele "neden seçtin"
    diye sorulmaz. Kod kapalı kümedir ki istemci kendi diliyle metin üretebilsin ve
    açıklama serbest metin taşımasın.
    """

    ALL_REQUIRED_SKILLS_VERIFIED = "ALL_REQUIRED_SKILLS_VERIFIED"
    EXPERT_LEVEL_SKILLS = "EXPERT_LEVEL_SKILLS"
    PREFERRED_SKILLS_MATCHED = "PREFERRED_SKILLS_MATCHED"
    PREFERRED_SKILLS_PARTIAL = "PREFERRED_SKILLS_PARTIAL"
    FULL_WINDOW_AVAILABLE = "FULL_WINDOW_AVAILABLE"
    PARTIAL_WINDOW_AVAILABLE = "PARTIAL_WINDOW_AVAILABLE"
    NEARBY = "NEARBY"
    WITHIN_SERVICE_AREA = "WITHIN_SERVICE_AREA"
    HIGH_RATING = "HIGH_RATING"
    LIMITED_RATING_HISTORY = "LIMITED_RATING_HISTORY"
    EXPERIENCED = "EXPERIENCED"


class ExplanationReason(BaseModel):
    """Tek bir gerekçe: kod + (varsa) sayısal dayanak.

    `value` yalnızca **bu karara ait türetilmiş** bir sayıdır (mesafe km, eşleşen
    yetkinlik sayısı gibi). Başka kullanıcının verisi taşınmaz (T-19).
    """

    model_config = ConfigDict(frozen=True)

    code: ExplanationCode
    value: float | None = None


class ScoreComponents(BaseModel):
    """Skor bileşenleri (ADR-0007 §5). Hepsi [0, 1] aralığında ve ayrı ayrı saklanır."""

    model_config = ConfigDict(frozen=True)

    skill_score: float = Field(ge=0.0, le=1.0)
    availability_score: float = Field(ge=0.0, le=1.0)
    quality_score: float = Field(ge=0.0, le=1.0)
    distance_score: float = Field(ge=0.0, le=1.0)
    rating_score: float = Field(ge=0.0, le=1.0)
    preference_score: float = Field(ge=0.0, le=1.0)


class RankedCandidate(BaseModel):
    """Sıralanmış aday. Sıralama optimizasyondan **bağımsız** üretilir."""

    model_config = ConfigDict(frozen=True)

    provider_id: UUID
    rank: int = Field(ge=1)
    components: ScoreComponents
    overall_score: float = Field(ge=0.0, le=1.0)
    explanation: tuple[ExplanationReason, ...] = ()
    distance_meters: int = Field(ge=0)
    travel_seconds: int = Field(ge=0)
    #: Kısıtların izin verdiği en erken başlangıç — optimizasyon çalışmasa da anlamlı.
    earliest_start: datetime | None = None


class EliminatedCandidate(BaseModel):
    """Elenen aday ve nedeni. Ölçüm ve hata ayıklama için; istemciye gösterilmez."""

    model_config = ConfigDict(frozen=True)

    provider_id: UUID
    violations: tuple[ConstraintCode, ...] = Field(min_length=1)


class RequestRanking(BaseModel):
    """Tek talebin sıralama sonucu."""

    model_config = ConfigDict(frozen=True)

    request_id: UUID
    candidates: tuple[RankedCandidate, ...] = ()
    eliminated: tuple[EliminatedCandidate, ...] = ()
    #: Kısıt değerlendirmesine giren toplam aday sayısı (elenenler dâhil).
    evaluated_count: int = Field(ge=0)


class Assignment(BaseModel):
    """Optimizasyonun (veya fallback'in) ürettiği atama."""

    model_config = ConfigDict(frozen=True)

    request_id: UUID
    provider_id: UUID
    scheduled_start: datetime
    scheduled_end: datetime
    travel_seconds: int = Field(ge=0)
    distance_meters: int = Field(ge=0)
    #: Atanan adayın sıralamadaki yeri — "hep 1 mi?" sorusu ölçülebilsin.
    rank: int = Field(ge=1)


class UnassignedReason(StrEnum):
    """Bir talebin neden atanamadığı."""

    NO_ELIGIBLE_CANDIDATE = "NO_ELIGIBLE_CANDIDATE"
    CAPACITY_EXHAUSTED = "CAPACITY_EXHAUSTED"
    NO_FEASIBLE_SCHEDULE = "NO_FEASIBLE_SCHEDULE"


class Unassigned(BaseModel):
    model_config = ConfigDict(frozen=True)

    request_id: UUID
    reason: UnassignedReason


class SolveStrategy(StrEnum):
    """Sonucu hangi yolun ürettiği.

    `RANKED_FALLBACK` bir hata değil, **işaretlenmiş** bir bozulmadır: optimizasyon
    çözüm üretemediğinde sıralamadan açgözlü atama yapılır ve sonuç bu etiketle döner
    (T-16). Etiketsiz bir fallback, bozulmayı ölçülemez kılardı.
    """

    OPTIMIZED = "OPTIMIZED"
    RANKED_FALLBACK = "RANKED_FALLBACK"
    RANKING_ONLY = "RANKING_ONLY"


class DegradedReason(StrEnum):
    OPTIMIZATION_TIMEOUT = "OPTIMIZATION_TIMEOUT"
    OPTIMIZATION_INFEASIBLE = "OPTIMIZATION_INFEASIBLE"
    OPTIMIZATION_ERROR = "OPTIMIZATION_ERROR"
    ROUTING_UNAVAILABLE = "ROUTING_UNAVAILABLE"


class SolveResult(BaseModel):
    """Matching yanıtı.

    Sürüm alanları zorunludur (ADR-0012 §1): sürümsüz bir karar geriye dönük
    karşılaştırmayı imkânsız kılar ve `booking_match_results` satırı yazılamaz.
    """

    model_config = ConfigDict(frozen=True)

    algorithm_version: str = Field(min_length=1, max_length=64)
    weights_version: str = Field(min_length=1, max_length=64)
    objective_version: str = Field(min_length=1, max_length=64)
    strategy: SolveStrategy
    degraded: bool = False
    degraded_reason: DegradedReason | None = None
    routing_provider: str = Field(min_length=1, max_length=32)
    rankings: tuple[RequestRanking, ...]
    assignments: tuple[Assignment, ...] = ()
    unassigned: tuple[Unassigned, ...] = ()
    #: **Üretilen çözümde** doğrulayıcının yakaladığı hard constraint ihlali sayısı.
    #: Hedef 0'dır ve 0'dan farklı olması bir hata sinyalidir: ihlalli atama sonuçtan
    #: çıkarılır, sayaç ölçüme girer (research-metrics §2.2 "hard constraint violation").
    #: Elenen aday sayısı bu alan değildir; o, `rankings[*].eliminated` içindedir.
    constraint_violations: int = Field(default=0, ge=0)
    scoring_runtime_ms: int = Field(default=0, ge=0)
    optimization_runtime_ms: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def _degraded_flag_matches_reason(self) -> SolveResult:
        if self.degraded != (self.degraded_reason is not None):
            raise ValueError("degraded bayrağı ile neden birlikte taşınmak zorunda")
        return self


SolveStatusLiteral = Literal["OPTIMIZED", "RANKED_FALLBACK", "RANKING_ONLY"]
