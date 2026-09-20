"""Parser davranışı: normalizasyon, zaman çözümleme, netleştirme, determinizm."""

from datetime import date

import pytest

from app.nlp.baseline import BaselineParser
from app.nlp.heuristic import HeuristicParser
from app.nlp.normalize import contains_term, fold, turkish_lower
from app.nlp.registry import available_versions, get_parser
from app.nlp.schema import ParseStatus
from app.nlp.temporal import resolve_date, resolve_duration, resolve_time_window

#: Pazartesi. Göreli ifadelerin beklenen sonucu buna göre yazılır.
TODAY = date(2026, 3, 2)


@pytest.fixture
def parser() -> HeuristicParser:
    return HeuristicParser()


class TestNormalization:
    def test_turkish_lower_handles_dotted_and_dotless_i(self) -> None:
        # Python'un varsayılan lower()'ı burada yanlış sonuç verir.
        assert turkish_lower("İSTANBUL") == "istanbul"
        assert turkish_lower("ISPARTA") == "ısparta"

    def test_fold_maps_turkish_characters_to_ascii(self) -> None:
        assert fold("Temizliğe İhtiyacım Var") == "temizlige ihtiyacim var"

    def test_contains_term_accepts_real_turkish_inflection(self) -> None:
        """Ek, karakter sayısıyla değil ek listesiyle tanınır (review bulgusu C2).

        Üç karakterlik bir bütçe "bebeğime" (bebeğ+im+e) gibi sıradan bir
        iyelik+hâl yığınını reddediyordu.
        """
        assert contains_term(fold("bebeğime bakacak"), "bebeg") is True
        assert contains_term(fold("temizliklerden bıktım"), "temizlik") is True
        assert contains_term(fold("yaşlılarımıza"), "yasli") is True
        assert contains_term(fold("temizliğe ihtiyacım var"), "temizlig") is True

    def test_contains_term_rejects_unrelated_words(self) -> None:
        # Kalıntı ("asir") bilinen eklere ayrıştırılamaz: "çamaşır" ≠ cam + ek.
        assert contains_term(fold("çamaşır yıkanacak"), "cam") is False
        # Önek serbest değil.
        assert contains_term(fold("eltemizlik"), "temizlik") is False

    def test_word_collisions_are_excluded_explicitly(self) -> None:
        """Dil bilgisiyle çözülemeyen çakışmalar listelenir (review bulgusu M1).

        "camiye" ek kurallarına göre geçerli bir çekimdir (cam + i + ye) ama "cami"
        ayrı bir kelimedir; müşterinin cami cümlesi cam temizliğine dönüşmemeli.
        """
        folded = fold("Camiye gidip namaz kılacağım")

        assert contains_term(folded, "cam") is True
        assert contains_term(folded, "cam", excluded=("cami",)) is False


class TestTemporal:
    def test_relative_days(self) -> None:
        assert resolve_date(fold("yarın gelsin"), today=TODAY).value == date(2026, 3, 3)  # type: ignore[union-attr]
        assert resolve_date(fold("bugün lazım"), today=TODAY).value == date(2026, 3, 2)  # type: ignore[union-attr]

    def test_weekday_resolves_to_next_occurrence(self) -> None:
        # 2026-03-02 pazartesi; "cuma" aynı haftanın cuması.
        assert resolve_date(fold("cuma günü"), today=TODAY).value == date(2026, 3, 6)  # type: ignore[union-attr]
        # "haftaya cuma" bir sonraki haftaya atlar.
        assert resolve_date(fold("haftaya cuma"), today=TODAY).value == date(2026, 3, 13)  # type: ignore[union-attr]

    def test_same_weekday_resolves_to_next_week_not_today(self) -> None:
        """Bugün pazartesiyken "pazartesi" demek, geçmişi değil gelecek haftayı kasteder."""
        assert resolve_date(fold("pazartesi"), today=TODAY).value == date(2026, 3, 9)  # type: ignore[union-attr]

    def test_invalid_numeric_date_is_not_invented(self) -> None:
        """31.02 diye bir gün yok: uydurmak yerine hiçbir tarih döndürülmez."""
        assert resolve_date(fold("31.02 tarihinde"), today=TODAY) is None

    def test_numeric_date_in_past_rolls_to_next_year(self) -> None:
        assert resolve_date(fold("15.01 günü"), today=TODAY).value == date(2027, 1, 15)  # type: ignore[union-attr]

    def test_clock_range_and_single_hour(self) -> None:
        ranged = resolve_time_window(fold("10:00-14:00 arası"))
        assert (ranged.value.start_hour, ranged.value.end_hour) == (10, 14)  # type: ignore[union-attr]

        single = resolve_time_window(fold("saat 18:00"))
        assert (single.value.start_hour, single.value.end_hour) == (18, 19)  # type: ignore[union-attr]

    def test_day_part_falls_back_to_shared_hours(self) -> None:
        window = resolve_time_window(fold("öğleden sonra"))
        assert (window.value.start_hour, window.value.end_hour) == (13, 18)  # type: ignore[union-attr]

    def test_bare_number_range_is_not_a_clock_range(self) -> None:
        """"3-5 kişi" bir saat aralığı değildir (review bulgusu C1).

        Çapasız sayı aralığı saat sayılsaydı, "sabah" diyen müşteriye 03:00
        randevusu oluşurdu ve aynı cümledeki "sabah" ezilirdi.
        """
        assert resolve_time_window(fold("3-5 kisi olacagiz")) is None
        assert resolve_time_window(fold("10-14 yas arasi cocuklar")) is None

    def test_day_part_survives_an_unrelated_number_range(self) -> None:
        window = resolve_time_window(fold("sabah gelsin, 3-5 kisi olacagiz"))

        assert window is not None
        assert (window.value.start_hour, window.value.end_hour) == (8, 12)

    def test_anchored_bare_range_is_accepted_with_lower_confidence(self) -> None:
        window = resolve_time_window(fold("saat 9-13 arasi"))

        assert window is not None
        assert (window.value.start_hour, window.value.end_hour) == (9, 13)
        # Açık saat gösteriminden (0.95) daha zayıf kanıt.
        assert window.confidence < 0.95

    def test_duration_out_of_range_is_dropped(self) -> None:
        """40 saat: şema zaten reddederdi, o yüzden hiç üretilmez."""
        assert resolve_duration(fold("40 saat")) is None
        assert resolve_duration(fold("3 saat")).value == 180  # type: ignore[union-attr]
        assert resolve_duration(fold("90 dakika")).value == 90  # type: ignore[union-attr]


class TestHeuristicParser:
    def test_parses_complete_request(self, parser: HeuristicParser) -> None:
        result = parser.parse("Yarın sabah 3 saatlik ev temizliği istiyorum", today=TODAY)

        assert result.status is ParseStatus.PARSED
        assert result.request is not None
        assert result.request.service_type == "standart-temizlik"
        assert result.request.duration_minutes == 180
        assert result.request.service_date == date(2026, 3, 3)
        assert result.parser_version == "heuristic-v1"

    def test_uppercase_turkish_input_is_understood(self, parser: HeuristicParser) -> None:
        """Baseline'ın kaçırdığı durum: Türkçe büyük harf."""
        result = parser.parse("TEMİZLİĞE İHTİYACIM VAR, CUMA ÖĞLEDEN SONRA", today=TODAY)

        assert result.request is not None
        assert result.request.service_type == "standart-temizlik"
        assert result.request.service_date == date(2026, 3, 6)

    def test_missing_date_triggers_clarification_not_a_guess(
        self, parser: HeuristicParser
    ) -> None:
        """Tarih uydurmak, yanlış günde rezervasyon demektir (ADR-0007 §2)."""
        result = parser.parse("Ev temizliği istiyorum", today=TODAY)

        assert result.status is ParseStatus.NEEDS_CLARIFICATION
        assert {question.field for question in result.clarifications} >= {"service_date"}
        assert result.request is not None
        assert result.request.service_date is None

    def test_unknown_request_asks_for_service_type(self, parser: HeuristicParser) -> None:
        result = parser.parse("Merhaba, yardıma ihtiyacım var", today=TODAY)

        assert result.status is ParseStatus.NEEDS_CLARIFICATION
        assert result.request is None
        assert result.confidence == 0.0
        assert result.clarifications[0].field == "service_type"

    def test_requirements_are_extracted_from_closed_vocabulary(
        self, parser: HeuristicParser
    ) -> None:
        result = parser.parse(
            "İki kedim var, yarın 14:00 civarı temizlik ve ütü yapılsın", today=TODAY
        )

        assert result.request is not None
        assert set(result.request.requirements) == {"pet-friendly", "utu"}

    def test_ambiguous_service_lowers_confidence(self, parser: HeuristicParser) -> None:
        """İki hizmet yakın puan alırsa güven düşer ve netleştirme sorulur."""
        confident = parser.parse("Yarın sabah taşınma temizliği", today=TODAY)
        ambiguous = parser.parse("Yaşlı bakımı mı temizlik mi karar veremedim", today=TODAY)

        assert ambiguous.confidence < confident.confidence
        assert ambiguous.status is ParseStatus.NEEDS_CLARIFICATION

    def test_parsing_is_deterministic(self, parser: HeuristicParser) -> None:
        """Aynı girdi + aynı gün → aynı sonuç (ADR-0007 §3)."""
        text = "Cuma öğleden sonra 4 saat detaylı temizlik, kedim var"

        first = parser.parse(text, today=TODAY)
        second = parser.parse(text, today=TODAY)

        assert first == second

    def test_today_is_injected_not_read_from_clock(self, parser: HeuristicParser) -> None:
        """Sistem saatine bağlı olsaydı aynı girdi farklı günlerde farklı sonuç verirdi."""
        first = parser.parse("yarın sabah temizlik", today=date(2026, 3, 2))
        second = parser.parse("yarın sabah temizlik", today=date(2026, 7, 20))

        assert first.request is not None
        assert second.request is not None
        assert first.request.service_date == date(2026, 3, 3)
        assert second.request.service_date == date(2026, 7, 21)


class TestBaselineParser:
    def test_baseline_misses_turkish_uppercase(self) -> None:
        """Baseline bilinçli olarak zayıftır; karşılaştırmanın anlamı buna dayanır."""
        result = BaselineParser().parse("TEMİZLİĞE İHTİYACIM VAR", today=TODAY)

        assert result.status is ParseStatus.NEEDS_CLARIFICATION

    def test_baseline_uses_fixed_confidence(self) -> None:
        result = BaselineParser().parse("yarın temizlik", today=TODAY)

        assert result.confidence == 0.5
        assert result.parser_version == "baseline-v0"


class TestRegistry:
    def test_both_versions_are_registered(self) -> None:
        assert set(available_versions()) == {"baseline-v0", "heuristic-v1"}

    def test_unknown_version_is_rejected_not_defaulted(self) -> None:
        """Sessizce varsayılana düşmek, sonucu yanlış sürüme atfederdi."""
        with pytest.raises(KeyError):
            get_parser("gpt-v9")
