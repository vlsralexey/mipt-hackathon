import json
from decimal import Decimal
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.models import Basis, Offer, Position, Question, Report

EXAMPLES = Path(__file__).parents[2] / "docs" / "api-examples"


def test_report_contract_roundtrip():
    data = json.loads((EXAMPLES / "report.json").read_text())
    report = Report.model_validate(data)
    assert Report.model_validate_json(report.model_dump_json()) == report
    assert isinstance(report.positions[0].unit_price, Decimal)
    assert report.model_dump(mode="json") == data
    assert "overrides" not in report.positions[0].model_dump()


def test_money_serialization_keeps_source_precision_until_boundary():
    data = json.loads((EXAMPLES / "report.json").read_text())["positions"][0]["included"][0][
        "offer"
    ]
    data["price"] = "3140.80333333333"
    offer = Offer.model_validate(data)
    assert offer.price == Decimal("3140.80333333333")
    assert offer.model_dump(mode="json")["price"] == "3140.80"


@pytest.mark.parametrize("value", ["0", "-1", "NaN", "Infinity"])
def test_invalid_basis(value):
    with pytest.raises(ValidationError):
        Basis(unit="шт", per_tz_unit=value)


def test_quantity_and_timezone_validation():
    with pytest.raises(ValidationError):
        Position(index=1, name="x", unit="шт", quantity=0, basis=Basis(unit="шт"))
    data = json.loads((EXAMPLES / "report.json").read_text())
    data["created_at"] = "2026-01-01T00:00:00"
    with pytest.raises(ValidationError):
        Report.model_validate(data)


def test_question_default_is_visible_option():
    with pytest.raises(ValidationError):
        Question(id="q", position_index=1, text="?", options=["да"], default_answer="нет")


def edit_data(kind, payload):
    return dict(
        id="e1",
        seq=1,
        created_at="2026-11-14T00:00:00Z",
        kind=kind,
        payload=payload,
        reason="Пользователь уточнил данные",
        origin="chat",
        status="active",
        summary="Правка",
    )


def test_edit_payload_discriminated_by_kind_and_keeps_wire_shape():
    from pydantic import TypeAdapter

    from app.models import CorrectOfferEdit, Edit

    adapter = TypeAdapter(Edit)
    data = edit_data("correct_offer", {"offer_id": "o1", "field": "amount", "value": "25"})
    edit = adapter.validate_python(data)
    assert isinstance(edit, CorrectOfferEdit)
    assert edit.payload.field == "amount"
    assert adapter.validate_json(adapter.dump_json(edit)) == edit
    with pytest.raises(ValidationError):
        adapter.validate_python(edit_data("answer_question", {"offer_id": "o1"}))


@pytest.mark.parametrize(
    "field,value",
    [
        ("amount", "0"),
        ("price", "-1"),
        ("vat_rate", ".5"),
        ("vat", "guess"),
        ("amount_unit", ""),
        ("supplier_inn", "1234"),
        ("price_date", "yesterday"),
        ("source_id", "eis"),
    ],
)
def test_invalid_offer_corrections(field, value):
    from pydantic import TypeAdapter

    from app.models import Edit

    with pytest.raises(ValidationError):
        TypeAdapter(Edit).validate_python(
            edit_data("correct_offer", {"offer_id": "o1", "field": field, "value": value})
        )


def test_snapshot_and_research_roundtrip_do_not_mix_raw_and_calculated_data():
    from datetime import date

    from fakes import offer

    from app.config import CalculationSnapshot, Rules
    from app.models import FoundOffer, ResearchRun, SourcePolicy

    snapshot = CalculationSnapshot(calc_date=date(2026, 11, 14), rules=Rules(), cpi={})
    assert CalculationSnapshot.model_validate_json(snapshot.model_dump_json()) == snapshot
    run = ResearchRun(
        id="run1",
        procurement_id="p",
        position_index=1,
        created_at="2026-11-14T00:00:00Z",
        kind="full",
        offers=[FoundOffer(offer=offer(), policy=SourcePolicy(price_final=True))],
    )
    assert ResearchRun.model_validate_json(run.model_dump_json()) == run
    assert "normalized_price" not in run.offers[0].model_dump()
    assert run.offers[0].policy.price_final


def test_research_storage_keeps_long_eis_price_but_report_money_has_two_digits():
    from fakes import offer

    from app.models import FoundOffer, ResearchRun, SourcePolicy

    source = offer(price="3140.80333333333", delivery_cost="10.005")
    run = ResearchRun(
        id="r",
        procurement_id="p",
        position_index=1,
        created_at="2026-11-14T00:00:00Z",
        kind="full",
        offers=[FoundOffer(offer=source, policy=SourcePolicy())],
    )
    assert ResearchRun.model_validate_json(run.model_dump_json()) == run
    assert source.model_dump(mode="json")["price"] == "3140.80"


def test_corrections_accept_russian_money_and_unit_alias():
    from pydantic import TypeAdapter

    from app.models import Edit

    adapter = TypeAdapter(Edit)
    edit = adapter.validate_python(
        edit_data("correct_offer", {"offer_id": "o1", "field": "price", "value": "1 500,50 ₽"})
    )
    assert edit.payload.value == "1500.50"
    edit = adapter.validate_python(
        edit_data("correct_offer", {"offer_id": "o1", "field": "amount_unit", "value": "Пач."})
    )
    assert edit.payload.value == "пачка"
