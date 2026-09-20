"""Metrik hesaplama (research-metrics.md §2.1).

Metrik tanımları deneyden **önce** yazılmıştır ve burada uygulanır. Tek başına
"doğruluk" raporlanmaz: intent için sınıf bazlı precision/recall/F1 + macro F1,
slot'lar için alan bazlı F1, ayrıca şema geçerlilik ve netleştirme oranı.

Neden sadece accuracy değil: sınıflar dengesiz. Sekiz hizmet türünden biri baskınsa
"hep onu tahmin et" yüksek accuracy verir ama işe yaramaz bir parser'dır. Macro F1
bu yanılsamayı kırar.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field


@dataclass(frozen=True)
class PRF:
    """Precision / recall / F1 üçlüsü."""

    precision: float
    recall: float
    f1: float
    support: int

    @classmethod
    def from_counts(cls, *, true_positive: int, false_positive: int, false_negative: int) -> PRF:
        precision = (
            true_positive / (true_positive + false_positive)
            if (true_positive + false_positive) > 0
            else 0.0
        )
        recall = (
            true_positive / (true_positive + false_negative)
            if (true_positive + false_negative) > 0
            else 0.0
        )
        f1 = (
            2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
        )
        return cls(
            precision=round(precision, 4),
            recall=round(recall, 4),
            f1=round(f1, 4),
            support=true_positive + false_negative,
        )


@dataclass
class _Counts:
    true_positive: int = 0
    false_positive: int = 0
    false_negative: int = 0


@dataclass(frozen=True)
class SlotMetrics:
    """Alan bazlı doğruluk.

    Üç sayaç ayrı tutulur, çünkü üç farklı hata birbirine karışmamalı:
    - `missed`: metinde vardı, çıkarılmadı (recall kaybı).
    - `spurious`: metinde yoktu, uyduruldu (**en tehlikelisi**: yanlış rezervasyon).
    - `wrong`: çıkarıldı ama değeri yanlış.
    """

    correct: int
    missed: int
    spurious: int
    wrong: int

    @property
    def total_gold(self) -> int:
        return self.correct + self.missed + self.wrong

    @property
    def f1(self) -> float:
        predicted = self.correct + self.spurious + self.wrong
        precision = self.correct / predicted if predicted else 0.0
        recall = self.correct / self.total_gold if self.total_gold else 0.0
        if precision + recall == 0:
            return 0.0
        return round(2 * precision * recall / (precision + recall), 4)


@dataclass(frozen=True)
class EvaluationReport:
    """Bir parser sürümünün tüm metrikleri."""

    parser_version: str
    example_count: int
    intent_per_class: dict[str, PRF]
    intent_macro_f1: float
    intent_accuracy: float
    slots: dict[str, SlotMetrics]
    slot_macro_f1: float
    schema_valid_rate: float
    clarification_rate: float
    #: Netleştirme sorulması **gerekenlerde** gerçekten soruldu mu?
    clarification_recall: float
    mean_confidence: float
    #: Kalibrasyon: |ortalama güven − doğruluk|. Küçük olması iyidir.
    calibration_gap: float


class MetricAccumulator:
    """Örnek örnek biriktirir, sonunda raporu üretir."""

    def __init__(self, parser_version: str) -> None:
        self._version = parser_version
        self._examples = 0
        self._intent: dict[str, _Counts] = defaultdict(_Counts)
        self._intent_correct = 0
        self._intent_predicted = 0
        self._slots: dict[str, _Counts] = defaultdict(_Counts)
        self._slot_correct: dict[str, int] = defaultdict(int)
        self._slot_wrong: dict[str, int] = defaultdict(int)
        self._slot_missed: dict[str, int] = defaultdict(int)
        self._slot_spurious: dict[str, int] = defaultdict(int)
        self._schema_valid = 0
        self._clarified = 0
        self._clarification_expected = 0
        self._clarification_expected_hit = 0
        self._confidence_sum = 0.0

    def add_intent(self, *, gold: str | None, predicted: str | None) -> None:
        if gold is None and predicted is None:
            # Doğru çekimserlik: metinde hizmet türü yoktu ve parser uydurmadı.
            # Bunu "yanlış" saymak, uydurmayı cezalandırmak yerine ödüllendirirdi.
            self._intent_correct += 1
            return

        if gold is not None and predicted is not None and gold == predicted:
            self._intent[gold].true_positive += 1
            self._intent_correct += 1
        else:
            if predicted is not None:
                self._intent[predicted].false_positive += 1
            if gold is not None:
                self._intent[gold].false_negative += 1
        if predicted is not None:
            self._intent_predicted += 1

    def add_slot(self, name: str, *, gold: object | None, predicted: object | None) -> None:
        if gold is None and predicted is None:
            return
        if gold is None:
            self._slot_spurious[name] += 1
        elif predicted is None:
            self._slot_missed[name] += 1
        elif gold == predicted:
            self._slot_correct[name] += 1
        else:
            self._slot_wrong[name] += 1

    def add_example(
        self,
        *,
        schema_valid: bool,
        clarified: bool,
        clarification_expected: bool,
        confidence: float,
    ) -> None:
        self._examples += 1
        if schema_valid:
            self._schema_valid += 1
        if clarified:
            self._clarified += 1
        if clarification_expected:
            self._clarification_expected += 1
            if clarified:
                self._clarification_expected_hit += 1
        self._confidence_sum += confidence

    def build(self) -> EvaluationReport:
        per_class = {
            label: PRF.from_counts(
                true_positive=counts.true_positive,
                false_positive=counts.false_positive,
                false_negative=counts.false_negative,
            )
            for label, counts in sorted(self._intent.items())
        }
        macro_f1 = (
            round(sum(prf.f1 for prf in per_class.values()) / len(per_class), 4)
            if per_class
            else 0.0
        )

        slot_names = (
            set(self._slot_correct)
            | set(self._slot_missed)
            | set(self._slot_spurious)
            | set(self._slot_wrong)
        )
        slots = {
            name: SlotMetrics(
                correct=self._slot_correct[name],
                missed=self._slot_missed[name],
                spurious=self._slot_spurious[name],
                wrong=self._slot_wrong[name],
            )
            for name in sorted(slot_names)
        }
        slot_macro_f1 = (
            round(sum(metric.f1 for metric in slots.values()) / len(slots), 4) if slots else 0.0
        )

        accuracy = self._intent_correct / self._examples if self._examples else 0.0
        mean_confidence = self._confidence_sum / self._examples if self._examples else 0.0

        return EvaluationReport(
            parser_version=self._version,
            example_count=self._examples,
            intent_per_class=per_class,
            intent_macro_f1=macro_f1,
            intent_accuracy=round(accuracy, 4),
            slots=slots,
            slot_macro_f1=slot_macro_f1,
            schema_valid_rate=round(
                self._schema_valid / self._examples if self._examples else 0.0, 4
            ),
            clarification_rate=round(
                self._clarified / self._examples if self._examples else 0.0, 4
            ),
            clarification_recall=round(
                self._clarification_expected_hit / self._clarification_expected
                if self._clarification_expected
                else 1.0,
                4,
            ),
            mean_confidence=round(mean_confidence, 4),
            calibration_gap=round(abs(mean_confidence - accuracy), 4),
        )


@dataclass(frozen=True)
class Comparison:
    """Baseline ile proposed'ın yan yana sonucu."""

    baseline: EvaluationReport
    proposed: EvaluationReport
    deltas: dict[str, float] = field(default_factory=dict)

    @classmethod
    def of(cls, baseline: EvaluationReport, proposed: EvaluationReport) -> Comparison:
        return cls(
            baseline=baseline,
            proposed=proposed,
            deltas={
                "intent_macro_f1": round(
                    proposed.intent_macro_f1 - baseline.intent_macro_f1, 4
                ),
                "intent_accuracy": round(proposed.intent_accuracy - baseline.intent_accuracy, 4),
                "slot_macro_f1": round(proposed.slot_macro_f1 - baseline.slot_macro_f1, 4),
                "clarification_recall": round(
                    proposed.clarification_recall - baseline.clarification_recall, 4
                ),
                # Kalibrasyon farkında **azalma** iyidir; işaret bu yüzden ters okunur.
                "calibration_gap": round(
                    proposed.calibration_gap - baseline.calibration_gap, 4
                ),
            },
        )
