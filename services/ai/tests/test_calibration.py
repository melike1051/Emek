"""Expected Calibration Error (R-46).

Testler iki şeyi ayrı ayrı doğrular: hesabın **doğruluğu** (elle hesaplanabilir
küçük örneklerle) ve ölçünün **ayırt ediciliği** — yani Faz 6'daki "ortalama fark"
ölçüsünün kaçırdığı durumu gerçekten yakalıyor mu?
"""

from __future__ import annotations

import pytest

from app.evaluation.calibration import CalibrationSample, expected_calibration_error
from app.evaluation.dataset import load_dataset
from app.evaluation.harness import PROPOSED_VERSION, collect_calibration
from app.nlp.registry import get_parser


def test_perfectly_calibrated_predictions_have_zero_error() -> None:
    """0.9 güvenle 10 tahminin 9'u doğruysa sapma yoktur."""
    samples = [CalibrationSample(confidence=0.9, correct=True) for _ in range(9)]
    samples.append(CalibrationSample(confidence=0.9, correct=False))

    report = expected_calibration_error(samples, bin_count=10)

    assert report.ece == 0.0
    assert report.accuracy == 0.9
    assert report.mean_confidence == 0.9


def test_overconfident_model_is_detected() -> None:
    samples = [CalibrationSample(confidence=0.95, correct=False) for _ in range(8)]
    samples += [CalibrationSample(confidence=0.95, correct=True) for _ in range(2)]

    report = expected_calibration_error(samples, bin_count=10)

    assert report.ece == pytest.approx(0.75, abs=0.01)
    assert report.overconfidence > 0


def test_underconfident_model_is_detected() -> None:
    samples = [CalibrationSample(confidence=0.3, correct=True) for _ in range(9)]
    samples.append(CalibrationSample(confidence=0.3, correct=False))

    report = expected_calibration_error(samples, bin_count=10)

    assert report.overconfidence < 0
    assert report.ece > 0.5


def test_mean_gap_hides_what_ece_reveals() -> None:
    """Faz 6'daki ölçünün neden yetersiz olduğu.

    Model yarı örneğe 1.0 güvenle yanlış, yarısına 0.0 güvenle doğru diyor:
    ortalama güven 0.5, doğruluk 0.5 → "ortalama fark" 0. Tamamen kalibresiz bir
    modeli mükemmel gösterir. ECE bunu 1.0 olarak yakalar.
    """
    samples = [CalibrationSample(confidence=1.0, correct=False) for _ in range(10)]
    samples += [CalibrationSample(confidence=0.0, correct=True) for _ in range(10)]

    report = expected_calibration_error(samples, bin_count=10)

    assert report.overconfidence == 0.0
    assert report.ece == 1.0
    assert report.max_calibration_error == 1.0


def test_brier_score_penalises_confident_mistakes() -> None:
    confident_wrong = expected_calibration_error(
        [CalibrationSample(confidence=1.0, correct=False)], bin_count=5
    )
    hedged_wrong = expected_calibration_error(
        [CalibrationSample(confidence=0.5, correct=False)], bin_count=5
    )

    assert confident_wrong.brier_score > hedged_wrong.brier_score


def test_confidence_of_one_lands_in_the_last_bin() -> None:
    report = expected_calibration_error(
        [CalibrationSample(confidence=1.0, correct=True)], bin_count=5
    )

    assert report.bins[-1].count == 1
    assert sum(bin_.count for bin_ in report.bins) == 1


def test_empty_bins_are_reported_but_do_not_affect_the_error() -> None:
    report = expected_calibration_error(
        [CalibrationSample(confidence=0.95, correct=True)], bin_count=10
    )

    assert len([bin_ for bin_ in report.bins if bin_.count == 0]) == 9
    assert report.ece == pytest.approx(0.05, abs=0.001)


def test_empty_sample_set_is_rejected() -> None:
    with pytest.raises(ValueError, match="en az bir örnek"):
        expected_calibration_error([], bin_count=5)


def test_confidence_outside_unit_range_is_rejected() -> None:
    with pytest.raises(ValueError, match="güven"):
        CalibrationSample(confidence=1.5, correct=True)


def test_nlp_calibration_is_measurable_on_the_evaluation_set() -> None:
    """R-46 kapanış koşulu: ECE artık gerçekten **ölçülüyor**.

    Test bir eşik dayatmaz: kalibrasyon iyileştirilmedi, ölçüldü. Eşik koymak,
    ölçülmemiş bir iyileşme iddiası olurdu.
    """
    samples = collect_calibration(get_parser(PROPOSED_VERSION), load_dataset())
    report = expected_calibration_error(samples, bin_count=5)

    assert report.sample_count > 0
    assert 0.0 <= report.ece <= 1.0
    assert sum(bin_.count for bin_ in report.bins) == report.sample_count
