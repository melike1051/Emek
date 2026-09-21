"""Değerlendirme koşucusu.

Bir parser sürümünü dataset üzerinde çalıştırır ve metrikleri toplar. Karşılaştırma
her zaman **aynı dataset ve aynı kod yolu** üzerinden yapılır: baseline'ı farklı bir
harness'la ölçmek, farkın nereden geldiğini belirsizleştirirdi.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.evaluation.calibration import CalibrationSample
from app.evaluation.dataset import EvaluationExample, load_dataset
from app.evaluation.metrics import Comparison, EvaluationReport, MetricAccumulator
from app.nlp.parser import RequestParser
from app.nlp.registry import get_parser
from app.nlp.schema import ParseResult, ParseStatus

BASELINE_VERSION = "baseline-v0"
PROPOSED_VERSION = "heuristic-v1"


@dataclass(frozen=True)
class ExampleError:
    """Tek bir örnekteki sapma.

    Hata analizi **koddan üretilir**, elle yazılmaz: Faz 6'da elle yazılan analiz
    yanlış örnekleri işaret etti ve gerçek bir hatanın (ek çözümleme) fark edilmesini
    geciktirdi (review bulgusu H1).
    """

    example_id: str
    category: str
    raw_text: str
    field: str
    gold: str | None
    predicted: str | None


def collect_errors(
    parser: RequestParser,
    examples: tuple[EvaluationExample, ...],
) -> tuple[ExampleError, ...]:
    """Beklenenden sapan her alanı listeler."""
    errors: list[ExampleError] = []

    for example in examples:
        result = parser.parse(example.raw_text, today=example.today)
        request = result.request
        predicted_intent = request.service_type if request is not None else None

        checks: list[tuple[str, object | None, object | None]] = [
            ("service_type", example.gold.service_type, predicted_intent),
            (
                "service_date",
                example.gold.service_date,
                request.service_date if request is not None else None,
            ),
            (
                "clarification",
                example.expect_clarification,
                result.status is ParseStatus.NEEDS_CLARIFICATION,
            ),
        ]

        # Yetkinlikler de listeye dâhil: aksi halde slot F1'deki eksik, hata
        # analizinde görünmez kalır ve rapor yine elle yorumlanmak zorunda kalırdı.
        #
        # Talep hiç üretilmediyse karşılaştırılacak bir şey yok: çekimserlik zaten
        # `service_type` satırında görünür, burada ikinci kez hata sayılmamalı.
        if request is not None:
            checks.append(
                (
                    "requirements",
                    tuple(sorted(example.gold.requirements)),
                    tuple(sorted(request.requirements)),
                )
            )

        if example.gold.duration_minutes is not None:
            checks.append(
                (
                    "duration_minutes",
                    example.gold.duration_minutes,
                    request.duration_minutes if request is not None else None,
                )
            )

        for field, gold, predicted in checks:
            if gold != predicted:
                errors.append(
                    ExampleError(
                        example_id=example.id,
                        category=example.category,
                        raw_text=example.raw_text,
                        field=field,
                        gold=None if gold is None else str(gold),
                        predicted=None if predicted is None else str(predicted),
                    )
                )

    return tuple(errors)


def evaluate(
    parser: RequestParser,
    examples: tuple[EvaluationExample, ...],
) -> EvaluationReport:
    """Parser'ı dataset üzerinde çalıştırır."""
    accumulator = MetricAccumulator(parser.version)

    for example in examples:
        result: ParseResult = parser.parse(example.raw_text, today=example.today)
        request = result.request

        accumulator.add_intent(
            gold=example.gold.service_type,
            predicted=request.service_type if request is not None else None,
        )

        # Süre her zaman bir değer taşır (varsayılan olsa bile), bu yüzden gold'da
        # `None` ise "metinde yoktu" demektir ve tahmin edilen değer uydurma sayılmaz —
        # varsayılanı hata saymak, makul bir tasarımı cezalandırırdı. Bu yüzden süre
        # yalnızca metinde açıkça geçtiğinde ölçülür.

        if example.gold.duration_minutes is not None:
            accumulator.add_slot(
                "duration_minutes",
                gold=example.gold.duration_minutes,
                predicted=request.duration_minutes if request is not None else None,
            )

        accumulator.add_slot(
            "service_date",
            gold=example.gold.service_date,
            predicted=request.service_date if request is not None else None,
        )

        predicted_window = (
            (request.time_window.start_hour, request.time_window.end_hour)
            if request is not None and request.time_window is not None
            else None
        )
        accumulator.add_slot(
            "time_window",
            gold=example.gold.time_window,
            predicted=predicted_window,
        )

        predicted_requirements = (
            tuple(sorted(request.requirements)) if request is not None else None
        )
        gold_requirements = tuple(sorted(example.gold.requirements))
        accumulator.add_slot(
            "requirements",
            gold=gold_requirements if gold_requirements else None,
            predicted=predicted_requirements if predicted_requirements else None,
        )

        accumulator.add_example(
            # Sonuç nesnesinin kendisi Pydantic doğrulamasından geçmiştir; buraya
            # ulaşmış olması şemaya uygunluğun kanıtıdır. REJECTED bir sonuç
            # şema ihlali demektir.
            schema_valid=result.status is not ParseStatus.REJECTED,
            clarified=result.status is ParseStatus.NEEDS_CLARIFICATION,
            clarification_expected=example.expect_clarification,
            confidence=result.confidence,
        )

    return accumulator.build()


def run_comparison(
    *,
    baseline_version: str = BASELINE_VERSION,
    proposed_version: str = PROPOSED_VERSION,
) -> Comparison:
    """Baseline ve proposed'ı aynı set üzerinde karşılaştırır (ADR-0012 §3)."""
    examples = load_dataset()
    baseline = evaluate(get_parser(baseline_version), examples)
    proposed = evaluate(get_parser(proposed_version), examples)
    return Comparison.of(baseline, proposed)


def collect_calibration(
    parser: RequestParser,
    examples: tuple[EvaluationExample, ...],
) -> tuple[CalibrationSample, ...]:
    """Güven kalibrasyonu örnekleri (R-46).

    "Doğru" tanımı **Faz 7'nin tükettiği karara** göre yapılır: core, eşiği geçen bir
    ayrıştırmadan hizmet türünü, günü ve saat penceresini alıp aday aramaya başlar.
    Dolayısıyla kalibrasyon açısından bir tahmin, ancak bu üç alan da doğruysa
    doğrudur. Yalnızca intent'e bakmak, yanlış güne randevu veren bir ayrıştırmayı
    "doğru" sayar ve eşiği ölçüsüz bırakırdı.

    Talep üretmeyen sonuçlar (netleştirme/red) örnekleme girmez: onlarda güvenin
    karşılık geldiği bir karar yoktur.
    """
    samples: list[CalibrationSample] = []

    for example in examples:
        result = parser.parse(example.raw_text, today=example.today)
        request = result.request
        if request is None:
            continue

        predicted_window = (
            (request.time_window.start_hour, request.time_window.end_hour)
            if request.time_window is not None
            else None
        )
        correct = (
            request.service_type == example.gold.service_type
            and request.service_date == example.gold.service_date
            and predicted_window == example.gold.time_window
        )
        samples.append(CalibrationSample(confidence=result.confidence, correct=correct))

    return tuple(samples)
