import json
from datetime import UTC, date, datetime, timedelta

import httpx
import pytest
from fakes import D, FakeLLM, offer, paper_position

from app.config import CalculationSnapshot, Rules, SourceConfig
from app.events import noop_emit
from app.llm.client import LLMFormatError
from app.models import (
    AnswerQuestionEdit,
    CharComparison,
    CorrectOfferEdit,
    ExcludeEdit,
    FoundOffer,
    IncludeEdit,
    ParsedTZ,
    Question,
    ResearchRun,
    SourcePolicy,
    SourceRun,
)
from app.pipeline.report import build_position, build_report
from app.pipeline.research import research_position, run_research
from app.sources.base import CandidatePage, SourceResult

AT = datetime(2026, 11, 14, tzinfo=UTC)
SNAP = CalculationSnapshot(calc_date=date(2026, 11, 14), rules=Rules(), cpi={})


def comparison(ok=True):
    return [CharComparison(name="Формат", required="А4", offered="А4", essential=True, ok=ok)]


def stored(prices=("290", "300", "280"), **overrides):
    offers = []
    for i, price in enumerate(prices):
        offers.append(
            FoundOffer(
                offer=offer(
                    id=f"o{i}",
                    price=price,
                    amount_unit="пачка",
                    title="Бумага",
                    url=f"https://shop{i}.ru/p",
                    vat="included",
                    delivery="included",
                ),
                policy=SourcePolicy(),
                comparison=comparison(),
            )
        )
    return ResearchRun(
        id="run",
        procurement_id="p",
        position_index=1,
        created_at=AT,
        kind="full",
        offers=offers,
        sources=[
            SourceRun(
                source_id="web",
                name="Веб",
                level=1,
                position_index=1,
                status="ok",
                found=len(offers),
                at=AT,
            )
        ],
        **overrides,
    )


def edit(cls, *, seq=1, **kwargs):
    kind = {ExcludeEdit: "exclude", IncludeEdit: "include", CorrectOfferEdit: "correct_offer"}[cls]
    return cls(
        id=f"e{seq}",
        seq=seq,
        created_at=AT,
        kind=kind,
        position_index=1,
        reason="Проверено пользователем",
        origin="chat",
        status="active",
        summary="Правка",
        payload={"offer_id": "o0"} | kwargs,
    )


def report(runs=None, edits=None, parsed=None):
    return build_report(
        SNAP,
        parsed or ParsedTZ(title="Бумага", positions=[paper_position()]),
        [stored()] if runs is None else runs,
        edits or [],
        1,
        "Поиск",
        procurement_id="p",
    )


def test_build_is_deterministic_and_keeps_input_immutable():
    run = stored()
    before = run.model_dump_json()
    one, two = report([run]), report([run])
    assert one.model_dump_json() == two.model_dump_json()
    assert one.total == D("725000.00") and one.total_justified == one.total
    assert run.model_dump_json() == before
    assert one.positions[0].included[0].label == "1.1"


def test_raw_run_roundtrip_does_not_round_source_prices():
    run = stored(("284.4102", "290", "300"))
    restored = ResearchRun.model_validate_json(run.model_dump_json())
    assert restored.offers[0].offer.price == D("284.4102")
    assert report([run]) == report([restored])


def test_correction_recalculates_pack_and_keeps_original():
    correction = edit(CorrectOfferEdit, field="amount", value="2")
    result = report(edits=[correction])
    entry = next(e for e in result.positions[0].included if e.offer.id == "o0")
    assert entry.base_price == D("145") and entry.original == {"amount": "1"}
    assert "corrected" in entry.user_marks
    assert result.total is None and result.positions[0].status == "heterogeneous"
    assert result.positions[0].reference_price == D("241.67")


def test_exclude_include_cancel_and_missing_target():
    exclusion = edit(ExcludeEdit)
    assert report(edits=[exclusion]).positions[0].status == "insufficient"
    inclusion = edit(IncludeEdit, seq=2)
    assert report(edits=[exclusion, inclusion]).positions[0].status == "ok"
    cancelled = exclusion.model_copy(update={"status": "cancelled"})
    assert report(edits=[cancelled]).total == D("725000")
    empty = stored(())
    result = report([empty], [exclusion])
    assert not result.edits[0].applied and "не найдено" in result.edits[0].effect
    newer = stored(("305", "300", "280")).model_copy(
        update={"id": "run2", "created_at": AT + timedelta(hours=1)}
    )
    assert report([newer], [exclusion]).positions[0].excluded[0].exclusion == "user_excluded"


def test_same_supplier_then_outliers_then_statistics():
    run = stored(("290", "300", "280", "285", "900"))
    run.offers[0].offer.supplier_inn = "7700000001"
    run.offers[1].offer.supplier_inn = "7700000001"
    run.offers[0].offer.price_date = date(2026, 10, 1)
    run.offers[1].offer.price_date = date(2026, 11, 1)
    pr = report([run]).positions[0]
    assert [e.exclusion for e in pr.excluded] == ["same_supplier", "anomalous_price"]
    assert pr.stats.n == 3 and pr.unit_price == D("288.33")


def test_force_include_can_bypass_matching_and_supplier_but_not_outliers():
    run = stored()
    run.offers[0].comparison = comparison(False)
    pr = report([run], [edit(IncludeEdit)]).positions[0]
    assert pr.status == "ok" and "included" in pr.included[0].user_marks
    run.offers[0].offer.price = D(9000)
    result = report([run], [edit(IncludeEdit)])
    assert result.positions[0].excluded[0].exclusion == "anomalous_price"
    assert not result.edits[0].applied


def test_wrong_unit_cannot_be_force_included():
    run = stored()
    run.offers[0].offer.amount_unit = "мг"
    result = report([run], [edit(IncludeEdit)])
    assert result.positions[0].excluded[0].exclusion == "unit_mismatch"
    assert not result.edits[0].applied


def test_vat_delivery_and_missing_cpi_are_visible():
    run = stored(("100", "122", "122"))
    run.offers[0].offer.vat = "excluded"
    assert report([run]).positions[0].unit_price == D(122)
    run.offers[0].offer.vat = "unknown"
    run.offers[0].offer.delivery = "unknown"
    run.offers[0].offer.price_date = date(2025, 1, 1)
    warnings = report([run]).warnings
    assert any("НДС не подтверждён у 1 из 3" in w for w in warnings)
    assert any("доставка не подтверждена у 1 из 3" in w for w in warnings)
    assert any("нет данных ИПЦ" in w for w in warnings)


def test_total_is_null_if_one_position_is_not_justified():
    parsed = ParsedTZ(
        title="Бумага",
        positions=[paper_position(), paper_position(index=2)],
        delivery_extras=["разгрузка"],
    )
    result = report(parsed=parsed)
    assert result.total is None and result.total_justified == D(725000)
    assert any("Позиция 2" in w for w in result.warnings)
    assert any("разгрузка" in w for w in result.warnings)


def test_other_procurement_runs_are_rejected():
    with pytest.raises(ValueError, match="другой закупке"):
        report([stored().model_copy(update={"procurement_id": "other"})])


def test_answer_changes_basis_and_delivery_without_network():
    parsed = ParsedTZ(
        title="Бумага",
        positions=[paper_position()],
        questions=[
            Question(
                id="q1-1",
                position_index=1,
                text="Количество?",
                options=["2500", "5000"],
                default_answer="2500",
            )
        ],
    )
    changed = paper_position(quantity="5000")
    answer = AnswerQuestionEdit(
        id="answer",
        seq=1,
        created_at=AT,
        kind="answer_question",
        position_index=1,
        reason="Уточнение",
        origin="button",
        status="active",
        summary="Количество",
        payload={"question_id": "q1-1", "answer": "5000", "position": changed},
    )
    result = report(edits=[answer], parsed=parsed)
    assert result.total == D(1450000) and result.questions[0].answer == "5000"
    assert result.positions[0].position.quantity == D(5000)
    assert parsed.positions[0].quantity == D(2500)
    bad = answer.model_copy(
        update={"payload": answer.payload.model_copy(update={"question_id": "missing"})}
    )
    assert report(edits=[bad], parsed=parsed).total == D(725000)
    assert not report(edits=[bad], parsed=parsed).edits[0].applied
    wrong_position = answer.model_copy(update={"position_index": 2})
    assert report(edits=[wrong_position], parsed=parsed).questions[0].answer is None


def test_force_include_bypasses_supplier_selection_and_exclusion_reason_is_visible():
    run = stored()
    for f in run.offers[:2]:
        f.offer.supplier_inn = "7700000001"
    assert len(report([run]).positions[0].included) == 2
    assert len(report([run], [edit(IncludeEdit)]).positions[0].included) == 3
    excluded = edit(ExcludeEdit).model_copy(update={"reason_kind": "price"})
    result = report([run], [excluded])
    assert any("по цене" in w for w in result.warnings)
    assert "excluded_by_price" in result.positions[0].excluded[0].user_marks


async def test_existing_exclusion_triggers_level2():
    first, second = Adapter(1, ("290", "300", "280")), Adapter(2, ("295",))
    llm = matching_llm()
    initial = await research_position(paper_position(), {1: [first]}, llm, SNAP, procurement_id="p")
    exclusion = ExcludeEdit.model_validate(
        edit(ExcludeEdit).model_dump() | {"payload": {"offer_id": initial.offers[0].offer.id}}
    )
    await research_position(
        paper_position(),
        {1: [first], 2: [second]},
        llm,
        SNAP,
        procurement_id="p",
        edits=[exclusion],
    )
    assert second.called == 1


class Adapter:
    def __init__(self, level, prices=(), error=None):
        self.id, self.name, self.level = f"source{level}", f"Источник {level}", level
        self.cfg = SourceConfig(id=self.id, name=self.name, level=level, type="web")
        self.prices, self.error, self.called = prices, error, 0

    async def search(self, position, rules):
        self.called += 1
        if self.error:
            raise self.error
        return SourceResult(
            run=SourceRun(
                source_id=self.id,
                name=self.name,
                level=self.level,
                position_index=position.index,
                status="ok" if self.prices else "empty",
                found=len(self.prices),
                at=AT,
            ),
            pages=[
                CandidatePage(
                    url=f"https://shop{self.level}-{i}.ru/p",
                    title="Бумага",
                    text=price,
                    retrieved_at=AT,
                )
                for i, price in enumerate(self.prices)
            ],
        )


def matching_llm():
    def respond(system, user, name):
        data = json.loads(user)
        if name == "offers":
            return {
                "offers": [
                    dict(
                        title="Бумага",
                        price=data["page"]["text"],
                        amount="1",
                        amount_unit="пачка",
                        vat="included",
                        delivery="included",
                        characteristics=[{"name": "Формат", "value": "А4"}],
                    )
                ]
            }
        if name == "comparison":
            return {"comparison": [{"name": "Формат", "offered": "А4", "ok": True}]}
        raise AssertionError(name)

    return FakeLLM(respond)


@pytest.mark.parametrize(
    "prices, level2",
    [(("290", "300", "280"), False), (("290",), True), (("100", "140", "60"), True)],
)
async def test_cascade_uses_normalized_and_filtered_level1(prices, level2):
    first, second = Adapter(1, prices), Adapter(2, ("100", "102", "98", "101"))
    run = await research_position(
        paper_position(),
        {1: [first], 2: [second]},
        matching_llm(),
        SNAP,
        noop_emit,
        procurement_id="p",
    )
    assert bool(second.called) == level2
    pr = build_position(paper_position(), [run], SNAP)
    assert pr.levels_used == ([1, 2] if level2 else [1])
    if not level2:
        assert pr.unit_price == D(290)


async def test_all_sources_down_still_produces_report_and_events():
    events = []

    async def emit(event):
        events.append(event)

    parsed = ParsedTZ(title="Бумага", positions=[paper_position()])
    result = await run_research(
        "p",
        parsed,
        {1: [Adapter(1, error=httpx.ConnectError("private"))]},
        matching_llm(),
        SNAP,
        emit,
    )
    assert result.report.total is None and result.report.positions[0].status == "insufficient"
    assert result.runs[0].sources[0].status == "unavailable"
    assert events[-1].type == "report" and events[0].type == "progress"
    assert "private" not in result.model_dump_json()


async def test_bad_llm_page_does_not_abort_research():
    class Broken:
        async def complete_json(self, *args):
            raise LLMFormatError("Неверный JSON")

    run = await research_position(
        paper_position(), {1: [Adapter(1, ("290",))]}, Broken(), SNAP, procurement_id="p"
    )
    assert not run.offers and len(run.skipped_pages) == 1
    assert "JSON" in run.skipped_pages[0].reason
