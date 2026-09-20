"""Evaluation harness ve metrik doğruluğu.

Harness'ın kendisi test edilmezse, ölçtüğü sayıların anlamı olmaz: yanlış hesaplanan
bir F1, yanlış bir Ar-Ge iddiası üretir.
"""

from datetime import date

import pytest

from app.evaluation.dataset import load_dataset
from app.evaluation.harness import BASELINE_VERSION, PROPOSED_VERSION, evaluate, run_comparison
from app.evaluation.metrics import PRF, MetricAccumulator, SlotMetrics
from app.nlp.registry import get_parser


class TestMetrics:
    def test_prf_from_counts(self) -> None:
        prf = PRF.from_counts(true_positive=8, false_positive=2, false_negative=4)

        assert prf.precision == 0.8
        assert prf.recall == pytest.approx(0.6667, abs=1e-4)
        assert prf.f1 == pytest.approx(0.7273, abs=1e-4)
        assert prf.support == 12

    def test_prf_is_zero_when_nothing_predicted(self) -> None:
        prf = PRF.from_counts(true_positive=0, false_positive=0, false_negative=5)

        assert prf.precision == 0.0
        assert prf.recall == 0.0
        assert prf.f1 == 0.0

    def test_slot_metrics_separate_spurious_from_missed(self) -> None:
        """Uydurma ile kaçırma aynı hata değildir: uydurma yanlış rezervasyon üretir."""
        metric = SlotMetrics(correct=6, missed=2, spurious=3, wrong=1)

        assert metric.total_gold == 9
        # precision = 6/10, recall = 6/9
        assert metric.f1 == pytest.approx(0.6316, abs=1e-4)

    def test_correct_abstention_counts_as_accurate(self) -> None:
        """Metinde hizmet yoksa ve parser uydurmadıysa bu doğru davranıştır."""
        accumulator = MetricAccumulator("test-v0")
        accumulator.add_intent(gold=None, predicted=None)
        accumulator.add_example(
            schema_valid=True, clarified=True, clarification_expected=True, confidence=0.1
        )

        report = accumulator.build()
        assert report.intent_accuracy == 1.0
        assert report.clarification_recall == 1.0

    def test_hallucinated_intent_is_penalised(self) -> None:
        accumulator = MetricAccumulator("test-v0")
        accumulator.add_intent(gold=None, predicted="standart-temizlik")
        accumulator.add_example(
            schema_valid=True, clarified=False, clarification_expected=True, confidence=0.9
        )

        report = accumulator.build()
        assert report.intent_accuracy == 0.0
        assert report.intent_per_class["standart-temizlik"].precision == 0.0
        # Netleştirme beklenirken sorulmadı.
        assert report.clarification_recall == 0.0


class TestDataset:
    def test_dataset_loads_and_is_unique(self) -> None:
        examples = load_dataset()

        assert len(examples) >= 20
        assert len({example.id for example in examples}) == len(examples)

    def test_every_example_has_a_reference_day(self) -> None:
        """Göreli ifadeler sabit bir güne göre etiketlenmezse set kullanılamaz."""
        for example in load_dataset():
            assert isinstance(example.today, date)

    def test_dataset_covers_ambiguous_and_injection_cases(self) -> None:
        categories = {example.category for example in load_dataset()}

        assert "belirsiz" in categories
        assert "injection" in categories

    def test_dataset_contains_no_contact_information(self) -> None:
        """Sentetik set: gerçek kişisel veri repoya girmez (ADR-0012 §4)."""
        for example in load_dataset():
            assert "@" not in example.raw_text
            assert "+90" not in example.raw_text


class TestHarness:
    def test_proposed_beats_baseline_on_every_headline_metric(self) -> None:
        """Ar-Ge iddiasının testi: fark ölçülebilir ve pozitif olmalı."""
        comparison = run_comparison()

        assert comparison.deltas["intent_macro_f1"] > 0
        assert comparison.deltas["slot_macro_f1"] > 0
        assert comparison.deltas["clarification_recall"] > 0

    def test_both_parsers_produce_schema_valid_output(self) -> None:
        examples = load_dataset()

        for version in (BASELINE_VERSION, PROPOSED_VERSION):
            report = evaluate(get_parser(version), examples)
            # Şema ihlali olsaydı sonuç nesnesi hiç üretilemezdi.
            assert report.schema_valid_rate == 1.0
            assert report.example_count == len(examples)

    def test_evaluation_is_reproducible(self) -> None:
        """Aynı set + aynı sürüm → aynı sayılar. Aksi halde deney raporlanamaz."""
        examples = load_dataset()
        parser = get_parser(PROPOSED_VERSION)

        first = evaluate(parser, examples)
        second = evaluate(parser, examples)

        assert first == second

    def test_injection_examples_are_parsed_correctly_by_proposed(self) -> None:
        """Talimat içeren metnin meşru kısmı yine de doğru ayrıştırılmalı."""
        examples = tuple(e for e in load_dataset() if e.category == "injection")
        parser = get_parser(PROPOSED_VERSION)

        for example in examples:
            result = parser.parse(example.raw_text, today=example.today)
            assert result.request is not None
            assert result.request.service_type == example.gold.service_type
