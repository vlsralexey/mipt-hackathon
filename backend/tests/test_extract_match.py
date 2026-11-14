from datetime import UTC, datetime

import pytest
from fakes import D, FakeLLM, offer, paper_position

from app.config import SourceConfig
from app.llm.client import LLMFormatError
from app.models import CharComparison
from app.pipeline.extract import extract_offers
from app.pipeline.match import compare, decide, dedupe, offer_id
from app.sources.base import CandidatePage, EisLine


class Source:
    cfg = SourceConfig(id="web", name="Веб", level=1, type="web")
    id, name, level = cfg.id, cfg.name, cfg.level


def page():
    return CandidatePage(
        url="https://shop.ru/p",
        title="Бумага",
        text="Цена 290 ₽",
        retrieved_at=datetime(2026, 11, 14, tzinfo=UTC),
    )


def raw(**overrides):
    return (
        dict(
            title="Бумага",
            price="290 ₽",
            amount="1",
            amount_unit="пач.",
            characteristics=[{"name": "Формат", "value": "А4"}],
        )
        | overrides
    )


async def test_extract_preserves_prices_and_sanitizes_optional_fields():
    rows = [
        raw(
            price="284,4102",
            vat_rate="22%",
            supplier_inn="не ИНН",
            delivery="separate",
            delivery_cost="по запросу",
            price_date="24.02.2026",
        ),
        raw(price="по запросу"),
        raw(amount="0"),
        raw(price="300", vat_rate="99%"),
    ]
    offers, fails = await extract_offers(
        FakeLLM([{"offers": rows}]), paper_position(), page(), Source()
    )
    assert len(offers) == 2 and len(fails) == 2
    assert offers[0].price == D("284.4102") and offers[0].vat_rate == D(".22")
    assert offers[0].supplier_inn is None and offers[0].delivery == "unknown"
    assert offers[0].amount_unit == "пачка" and offers[0].price_date.isoformat() == "2026-02-24"
    assert offers[1].vat_rate is None


async def test_bad_llm_response_is_skipped_page():
    class BrokenLLM:
        async def complete_json(self, *args):
            raise LLMFormatError("Некорректный JSON")

    offers, fails = await extract_offers(BrokenLLM(), paper_position(), page(), Source())
    assert not offers and "JSON" in fails[0].reason


async def test_eis_unit_price_is_not_divided_by_contract_quantity():
    candidate = page().model_copy(
        update={
            "eis_lines": [
                EisLine(
                    index=1,
                    title="Бумага для офисной техники",
                    price=D("320.80"),
                    amount_unit="пачка",
                    vat="included",
                    vat_rate=D(".22"),
                    characteristics={"Формат": "А4"},
                )
            ]
        }
    )
    offers, fails = await extract_offers(
        FakeLLM(
            [
                {
                    "offers": [
                        raw(
                            line_index=1,
                            amount="1000",
                            price="320800",
                            vat="excluded",
                            characteristics=[],
                        )
                    ]
                }
            ]
        ),
        paper_position(),
        candidate,
        Source(),
    )
    assert not fails and len(offers) == 1
    assert offers[0].price == D("320.80") and offers[0].amount == 1
    assert offers[0].vat == "included" and offers[0].characteristics == {"Формат": "А4"}


def test_identity_is_price_independent_but_keeps_contract_and_pack():
    a = offer_id("https://Shop.ru/p?utm=x#foo", "Бумага", D(1), "пач.")
    assert a == offer_id("https://shop.ru/p/", "БУМАГА", D("1.00"), "пачка")
    assert a != offer_id("https://shop.ru/p", "Бумага", D(5), "пачка")
    assert offer_id("https://zakupki.gov.ru/p?reestrNumber=1", "Бумага", D(1), "пачка") != offer_id(
        "https://zakupki.gov.ru/p?reestrNumber=2", "Бумага", D(1), "пачка"
    )


def test_dedupe_keeps_suppliers_and_multiple_rows():
    a = offer(url="https://Shop.ru/p?utm=x", title="А4")
    b = offer(url="https://shop.ru/p/", title="А4")
    c = offer(url="https://other.ru/p", title="А4")
    d = offer(url=a.url, title="А3")
    unique, duplicates = dedupe([a, b, c, d])
    assert unique == [a, c, d] and duplicates == [b]


async def test_compare_cannot_change_essential_flag_or_omit_requirement():
    position = paper_position(
        characteristics=[
            {"name": "Формат", "value": "А4", "essential": True},
            {"name": "Марка", "value": "SvetoCopy", "essential": True},
        ]
    )
    llm = FakeLLM([{"comparison": [{"name": "Формат", "offered": "А3", "ok": False}]}])
    comparisons = await compare(llm, position, offer())
    assert len(comparisons) == 2 and comparisons[1].ok is None
    assert decide(comparisons)[0] == "incomparable"


async def test_brand_case_is_not_a_contradiction_but_distinct_model_is():
    position = paper_position(
        characteristics=[
            {"name": "Товарный знак", "value": "SvetoCopy", "essential": True},
            {"name": "Модель", "value": "D600 PRO", "essential": True},
        ]
    )
    llm = FakeLLM(
        [
            {
                "comparison": [
                    {"name": "Товарный знак", "offered": "Svetocopy", "ok": False},
                    {"name": "Модель", "offered": "D600", "ok": False},
                ]
            }
        ]
    )
    result = await compare(llm, position, offer(title="Бумага Svetocopy D600"))
    assert result[0].ok is True and result[1].ok is False
    assert decide(result)[0] == "incomparable"


@pytest.mark.parametrize(
    "ok, expected", [(False, "incomparable"), (None, "insufficient_data"), (True, None)]
)
def test_decide_uses_only_essential(ok, expected):
    rows = [
        CharComparison(name="Формат", required="А4", essential=True, offered="А4", ok=ok),
        CharComparison(name="Цвет", required="белый", essential=False, ok=False),
    ]
    assert decide(rows)[0] == expected
