"""Güven kalibrasyonu: Expected Calibration Error (R-46).

Faz 6'da kalibrasyon yalnızca **ortalama güven ile doğruluk farkı** olarak
raporlanmıştı. Bu ölçü yanıltıcıdır: yarısına 0.99, yarısına 0.01 güven veren ve
tam tersini yapan bir model ile her örneğe 0.5 veren bir model aynı ortalamayı
üretebilir. Ortalama fark 0 çıkar, model ise tamamen kalibresizdir.

ECE bunu güven aralıklarına bölerek ölçer (research-metrics §2.1):

    ECE = Σ_b (n_b / N) · |acc_b − conf_b|

Neden Faz 7'de: karar zinciri `parser_confidence` eşiğine göre talep oluşturup
oluşturmamaya karar verir (`MIN_AUTO_CONFIDENCE`). Eşik, güvenin gerçek doğrulukla
ilişkili olduğu varsayımına dayanır. Kalibrasyon ölçülmeden bu eşik bir tahmindir.

**Ölçüm iyileştirme değildir.** Bu modül kalibrasyonu ölçer; kalibrasyonu düzelten
(sıcaklık ölçekleme, isotonic regression) bir bileşen yoktur ve sonuçlar "kalibrasyon
iyileştirildi" diye raporlanmaz.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class CalibrationSample:
    """Tek bir tahmin: modelin güveni ve gerçekten doğru olup olmadığı."""

    confidence: float
    correct: bool

    def __post_init__(self) -> None:
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("güven [0, 1] aralığında olmalı")


@dataclass(frozen=True)
class CalibrationBin:
    """Bir güven aralığının özeti — reliability diagram'ın tek çubuğu."""

    lower: float
    upper: float
    count: int
    mean_confidence: float
    accuracy: float

    @property
    def gap(self) -> float:
        """|doğruluk − güven|: çubuğun köşegenden sapması."""
        return round(abs(self.accuracy - self.mean_confidence), 4)


@dataclass(frozen=True)
class CalibrationReport:
    """Kalibrasyon ölçümü.

    Üç sayı birlikte okunur:
    - `ece`: ortalama sapma (küçük iyi).
    - `max_calibration_error`: en kötü kovadaki sapma — ortalama iyi görünürken tek
      bir kovada büyük sapma olabilir.
    - `brier_score`: hem kalibrasyonu hem ayırt ediciliği birlikte cezalandırır;
      yalnız ECE'ye bakmak, "her örneğe taban oranı ver" gibi ayırt edici olmayan
      ama iyi kalibre bir modeli mükemmel gösterirdi.
    """

    sample_count: int
    bin_count: int
    ece: float
    max_calibration_error: float
    brier_score: float
    mean_confidence: float
    accuracy: float
    #: Ortalama güven − doğruluk. Pozitif: model fazla özgüvenli.
    overconfidence: float
    bins: tuple[CalibrationBin, ...]


def expected_calibration_error(
    samples: Sequence[CalibrationSample],
    *,
    bin_count: int = 10,
) -> CalibrationReport:
    """Eşit genişlikli kovalarla ECE hesaplar.

    Eşit **genişlik** (eşit frekans değil) seçildi: reliability diagram'ın x ekseni
    güven olduğu için kovalar güven ekseninde eşit olmalı, yoksa çubuklar okunamaz.
    Boş kovalar ECE'ye katkı vermez (n_b = 0) ama raporda görünür — hangi güven
    aralığında hiç örnek olmadığı da bir bulgudur.
    """
    if bin_count < 1:
        raise ValueError("kova sayısı en az 1 olmalı")

    total = len(samples)
    if total == 0:
        raise ValueError("kalibrasyon ölçümü için en az bir örnek gerekir")

    buckets: list[list[CalibrationSample]] = [[] for _ in range(bin_count)]
    for sample in samples:
        # 1.0 son kovaya düşmeli; aksi hâlde indeks taşardı.
        index = min(bin_count - 1, int(sample.confidence * bin_count))
        buckets[index].append(sample)

    bins: list[CalibrationBin] = []
    ece = 0.0
    max_error = 0.0

    for index, bucket in enumerate(buckets):
        lower = index / bin_count
        upper = (index + 1) / bin_count
        count = len(bucket)

        if count == 0:
            bins.append(
                CalibrationBin(
                    lower=round(lower, 4),
                    upper=round(upper, 4),
                    count=0,
                    mean_confidence=0.0,
                    accuracy=0.0,
                )
            )
            continue

        mean_confidence = sum(sample.confidence for sample in bucket) / count
        accuracy = sum(1 for sample in bucket if sample.correct) / count
        gap = abs(accuracy - mean_confidence)

        ece += (count / total) * gap
        max_error = max(max_error, gap)

        bins.append(
            CalibrationBin(
                lower=round(lower, 4),
                upper=round(upper, 4),
                count=count,
                mean_confidence=round(mean_confidence, 4),
                accuracy=round(accuracy, 4),
            )
        )

    mean_confidence = sum(sample.confidence for sample in samples) / total
    accuracy = sum(1 for sample in samples if sample.correct) / total
    brier = sum((sample.confidence - float(sample.correct)) ** 2 for sample in samples) / total

    return CalibrationReport(
        sample_count=total,
        bin_count=bin_count,
        ece=round(ece, 4),
        max_calibration_error=round(max_error, 4),
        brier_score=round(brier, 4),
        mean_confidence=round(mean_confidence, 4),
        accuracy=round(accuracy, 4),
        overconfidence=round(mean_confidence - accuracy, 4),
        bins=tuple(bins),
    )
