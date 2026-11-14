"""P1: подтверждение отделено от предложения, история и расчёты воспроизводимы."""

from decimal import Decimal

import pytest
from pydantic import ValidationError
from test_api import api, idle, ready
from test_research import stored

from app.agent.chat import Turn
from app.models import EditPositionPayload, ExcludeWherePayload
from app.p1.actions import Actions
from app.service import ActionError
from app.store.repo import Repo


async def proposal_turn(service, llm, pid, **filters):
    turn = Turn(service, pid, llm, {})
    result = await turn.execute(
        "exclude_where",
        {
            "position_index": 1,
            "filter": filters or {"normalized_price_above": "285"},
            "reason": "Указанные пользователем предложения не подходят",
        },
    )
    return turn, result


async def test_proposal_requires_next_turn_and_survives_restart(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        turn, proposal = await proposal_turn(service, llm, pid)
        assert proposal["status"] == "pending"
        assert proposal["diff"]["positions"][0]["n"] == {"before": 3, "after": 1}
        assert service.repo.get_report(pid).version == 1
        with pytest.raises(ActionError, match="том же ходе"):
            await turn.execute("apply_proposal", {"proposal_id": proposal["id"]})
        service.actions = Actions(service)
        accepted = Turn(service, pid, None, {}, origin="button")
        await service.actions.apply_into(accepted, proposal["id"])
        await accepted.commit()
        report = service.repo.get_report(pid)
        assert report.version == 2 and len(report.positions[0].included) == 1
        assert report.edits[0].edit.reason_kind == "price"
        assert any("по цене" in warning for warning in report.warnings)
        assert service.actions._row(pid, proposal["id"])["message"].data.status == "applied"
        assert len(service.repo.runs(pid)[0].offers) == 3
        reopened = Repo(service.repo.path)
        assert reopened.get_report(pid, 1).positions[0].stats.n == 3
        with pytest.raises(ActionError):
            service.actions.pending(pid, proposal["id"])


async def test_pending_expiry_and_reject_are_terminal(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        _, rejected = await proposal_turn(service, llm, pid)
        await service.actions.reject(pid, rejected["id"])
        with pytest.raises(ActionError):
            await service.actions.reject(pid, rejected["id"])
        _, expired = await proposal_turn(service, llm, pid)
        async with service.locks[pid]:
            report = await service.commit(pid, [], service.repo.runs(pid), "Новый поиск")
        await service.actions.expire(pid, report.version)
        assert service.actions._row(pid, expired["id"])["message"].data.status == "expired"
        with pytest.raises(ActionError):
            service.actions.pending(pid, expired["id"])


async def test_mass_filter_applies_to_new_results_and_cancel_restores(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        _, proposal = await proposal_turn(service, llm, pid, source_ids=["web"])
        apply = Turn(service, pid, None, {})
        await service.actions.apply_into(apply, proposal["id"])
        await apply.commit()
        new = stored(("310", "320", "330")).model_copy(update={"id": "new", "procurement_id": pid})
        for found in new.offers:
            found.offer.id += "new"
        async with service.locks[pid]:
            await service.commit(pid, service.repo.edits(pid), [new], "Повторный поиск")
        assert not service.repo.get_report(pid).positions[0].included
        cancel = Turn(service, pid, None, {})
        await cancel.cancel([service.repo.edits(pid)[0].id])
        await cancel.commit()
        assert service.repo.get_report(pid).positions[0].status == "ok"


async def test_position_quantity_recalculates_without_search_and_invalid_field_is_atomic(
    tmp_path, monkeypatch
):
    async with api(tmp_path, monkeypatch) as (client, service, llm, searches):
        pid = await ready(client, service)
        turn = Turn(service, pid, llm, {})
        await turn.execute(
            "edit_position",
            {
                "position_index": 1,
                "field": "quantity",
                "value": "10",
                "reason": "Нужно десять пачек",
            },
        )
        await turn.commit()
        report = service.repo.get_report(pid)
        assert report.positions[0].position.quantity == 10
        assert report.total == Decimal("2900")
        assert len(searches) == 1
        bad = Turn(service, pid, llm, {})
        with pytest.raises(ValueError, match="не найдена"):
            await bad.execute(
                "edit_position",
                {
                    "position_index": 1,
                    "field": "characteristic:нет",
                    "value": "А3",
                    "reason": "новое ТЗ",
                },
            )
        assert not bad.changed and len(bad.edits) == 1
        await bad.commit()
        assert service.repo.get_report(pid).version == 2


async def test_revert_restores_runs_and_edits_without_mutating_old_versions(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        original = service.repo.get_report(pid).model_dump_json()
        turn = Turn(service, pid, llm, {})
        await turn.exclude("o0", "б/у", "other")
        await turn.commit()
        proposal = await Turn(service, pid, llm, {}).execute("revert_to_version", {"version": 1})
        accepted = Turn(service, pid, None, {})
        await service.actions.apply_into(accepted, proposal["id"])
        await accepted.commit()
        assert service.repo.get_report(pid).version == 3
        assert service.repo.get_report(pid).positions[0].status == "ok"
        assert service.repo.edits(pid)[0].status == "cancelled"
        assert service.repo.get_report(pid, 1).model_dump_json() == original
        assert service.repo.get_report(pid, 2).positions[0].status == "insufficient"


async def test_find_and_diff_are_read_only(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        turn = Turn(service, pid, llm, {})
        rows = await turn.execute(
            "find_offers",
            {
                "position_index": 1,
                "filter": {"normalized_price_above": "285", "normalized_price_below": "295"},
            },
        )
        assert [row["offer"]["id"] for row in rows] == ["o0"]
        delta = await turn.execute("diff_versions", {"a": 1, "b": 1})
        assert delta["positions"] == [] and delta["offers_moved"] == []
        await turn.commit()
        assert service.repo.get_report(pid).version == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("quantity", "0"),
        ("quantity", True),
        ("essential:Формат", "false"),
        ("basis", "мкг"),
        ("name", " "),
    ],
)
def test_position_input_rejects_invalid_values(field, value):
    with pytest.raises(ValidationError):
        EditPositionPayload(field=field, value=value)


def test_price_filter_requires_one_position():
    with pytest.raises(ValidationError):
        ExcludeWherePayload(filter={"normalized_price_above": "100"})


async def test_essential_flag_reuses_comparison_without_network(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, searches):
        pid = await ready(client, service)
        original = service.require(pid)["parsed"].model_dump_json()
        turn = Turn(service, pid, None, {})
        await turn.execute(
            "edit_position",
            {
                "position_index": 1,
                "field": "essential:Формат",
                "value": False,
                "reason": "Формат не существенен",
            },
        )
        await turn.commit()
        assert service.repo.get_report(pid).version == 2
        assert len(searches) == 1
        assert service.require(pid)["parsed"].model_dump_json() == original
        assert (
            service.repo.get_report(pid).positions[0].position.characteristics[0].essential is False
        )


async def test_add_url_is_real_extraction_cancel_removes_run_and_full_search_keeps_it(
    tmp_path, monkeypatch
):
    from app.sources.base import CandidatePage
    from app.store.repo import now

    async def page(*args):
        return CandidatePage(
            url="https://supplier.ru/paper",
            title="Бумага",
            text="Пачка А4, 295 рублей",
            retrieved_at=now(),
        )

    monkeypatch.setattr("app.p1.actions.fetch_page", page)
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        llm.json_responses = iter(
            [
                {
                    "offers": [
                        {
                            "title": "Бумага А4",
                            "price": "295",
                            "amount": "1",
                            "amount_unit": "пачка",
                        }
                    ]
                },
                {"comparison": [{"name": "Формат", "offered": "А4", "ok": True}]},
            ]
        )
        turn = Turn(service, pid, llm, {})
        await turn.execute(
            "add_offer_from_url", {"position_index": 1, "url": "https://supplier.ru/paper"}
        )
        await turn.commit()
        report = service.repo.get_report(pid)
        assert any("added" in row.user_marks for row in report.positions[0].included)
        assert {run.kind for run in service.repo.runs(pid)} == {"full", "user"}
        service.rerun(pid, [1])
        await idle(service, pid)
        assert any(run.kind == "user" for run in service.repo.runs(pid))
        cancel = Turn(service, pid, None, {})
        await cancel.cancel([service.repo.edits(pid)[0].id])
        await cancel.commit()
        assert all(
            "added" not in row.user_marks
            for row in service.repo.get_report(pid).positions[0].included
        )
        assert all(source.source_id != "user" for source in service.repo.get_report(pid).sources)
        assert any(run.kind == "user" for run in service.repo.runs(pid))  # immutable raw history


async def test_targeted_search_adds_results_and_preserves_adapter_configuration(
    tmp_path, monkeypatch
):
    from types import SimpleNamespace

    from app.config import SourceConfig

    seen = []

    async def targeted(position, adapters, *args, procurement_id, **kwargs):
        seen.append(adapters)
        run = stored(("295",)).model_copy(
            update={"id": "targeted", "procurement_id": procurement_id}
        )
        run.offers[0].offer.id = "extra"
        run.offers[0].offer.url = "https://target.ru/product"
        return run

    monkeypatch.setattr("app.p1.actions.research_position", targeted)
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        cfg = SourceConfig(
            id="web", name="Веб", level=2, type="web", params={"sites": ["other.ru"]}
        )
        adapter = SimpleNamespace(cfg=cfg, id="web", name="Веб", level=2)
        turn = Turn(service, pid, llm, {2: [adapter]})
        await turn.execute(
            "search_more",
            {"position_index": 1, "levels": [2], "site": "target.ru", "query": "бумага"},
        )
        await turn.commit()
        assert cfg.params == {"sites": ["other.ru"]}
        assert seen[0][1][0].cfg.params["sites"] == ["target.ru"]
        assert len(service.repo.get_report(pid).positions[0].included) == 4
        assert {run.kind for run in service.repo.runs(pid)} == {"full", "targeted"}
        assert service.repo.get_report(pid, 1).positions[0].stats.n == 3


async def test_proposal_buttons_and_diff_api_need_no_key(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        _, proposal = await proposal_turn(service, llm, pid)
        service.settings.openrouter_api_key = None
        response = await client.post(f"/api/procurements/{pid}/proposals/{proposal['id']}/apply")
        assert response.status_code == 202
        await idle(service, pid)
        assert service.repo.get_report(pid).version == 2
        diff = await client.get(f"/api/procurements/{pid}/reports/1/diff/2")
        assert diff.status_code == 200
        assert diff.json()["positions"][0]["n"] == {"before": 3, "after": 1}
        assert (
            await client.post(f"/api/procurements/{pid}/proposals/{proposal['id']}/apply")
        ).status_code == 409
        assert (await client.get(f"/api/procurements/{pid}/reports/1/diff/99")).status_code == 404


async def test_restart_requires_confirmation_keeps_edits_and_records_new_date(
    tmp_path, monkeypatch
):
    from datetime import date, datetime
    from zoneinfo import ZoneInfo

    async with api(tmp_path, monkeypatch) as (client, service, llm, searches):
        pid = await ready(client, service)
        snapshot = service.require(pid)["snapshot"]
        snapshot.calc_date = date(2020, 1, 1)
        service.repo.update(pid, snapshot_json=snapshot.model_dump_json())
        change = Turn(service, pid, llm, {})
        await change.exclude("o0", "б/у", "other")
        await change.commit()
        prior = service.repo.get_report(pid)
        assert prior.calc_date == date(2020, 1, 1)
        turn = Turn(service, pid, llm, {})
        proposal = await turn.execute("restart_research", {})
        assert len(searches) == 1 and service.repo.get_report(pid).version == 2
        accepted = Turn(service, pid, None, {}, origin="button")
        await service.actions.apply_into(accepted, proposal["id"])
        await accepted.commit()
        await idle(service, pid)
        report = service.repo.get_report(pid)
        assert len(searches) == 2 and report.version == 3
        assert report.calc_date == datetime.now(ZoneInfo("Europe/Moscow")).date()
        assert any(
            row.offer.id == "o0" and row.exclusion == "user_excluded"
            for row in report.positions[0].excluded
        )
        assert service.require(pid)["snapshot"].calc_date == date(2020, 1, 1)
        assert service.repo.get_report(pid, 2).model_dump_json() == prior.model_dump_json()
        assert service.actions._row(pid, proposal["id"])["message"].data.status == "applied"


async def test_pending_fingerprint_rejects_edits_without_version_and_commit_race(
    tmp_path, monkeypatch
):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        _, proposal = await proposal_turn(service, llm, pid)
        edit = Turn(service, pid, llm, {})
        await edit.exclude("o0", "б/у", "other")
        async with service.locks[pid]:
            await service.commit(
                pid, edit.edits, service.repo.runs(pid), "До следующей версии", create_version=False
            )
        assert service.repo.get_report(pid).version == 1
        with pytest.raises(ActionError, match="устарело"):
            await service.actions.apply_into(Turn(service, pid, None, {}), proposal["id"])
        _, fresh = await proposal_turn(service, llm, pid)
        applying = Turn(service, pid, None, {})
        await service.actions.apply_into(applying, fresh["id"])
        async with service.locks[pid]:
            await service.commit(pid, edit.edits, service.repo.runs(pid), "Поиск завершился")
        with pytest.raises(ActionError, match="устарело"):
            await applying.commit()
        assert len(service.repo.edits(pid)) == 1
        assert service.actions._row(pid, fresh["id"])["message"].data.status == "expired"
        assert not service.actions.applying


async def test_filter_and_rule_warnings_and_mass_include_explanation(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        turn = Turn(service, pid, None, {})
        proposal = await turn.execute(
            "change_local_setting",
            {"key": "rules.cv_threshold", "value": "0.4", "reason": "Положение о закупке"},
        )
        accept = Turn(service, pid, None, {})
        await service.actions.apply_into(accept, proposal["id"])
        await accept.commit()
        assert any("40 % мягче" in warning for warning in service.repo.get_report(pid).warnings)
        _, mass = await proposal_turn(service, llm, pid, source_ids=["web"])
        accept = Turn(service, pid, None, {})
        await service.actions.apply_into(accept, mass["id"])
        await accept.commit()
        with pytest.raises(ActionError, match="условием или настройкой"):
            await Turn(service, pid, None, {}).include("o0", "верни")


async def test_punctuation_roundtrip_does_not_create_false_methodology_diff(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        _, proposal = await proposal_turn(service, llm, pid)
        assert proposal["diff"]["rules_changed"] == []
        turn = Turn(service, pid, None, {})
        await turn.exclude("o0", "б/у", "other")
        await turn.commit()
        card = [
            message for message in service.repo.list_messages(pid) if message.kind == "version"
        ][-1]
        assert card.data.diff.rules_changed == []
        assert (
            service.repo.get_report(pid).rules["methodology_note"]
            == service.repo.get_report(pid, 1).rules["methodology_note"]
        )
