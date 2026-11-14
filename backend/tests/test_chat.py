import asyncio
from decimal import Decimal

import pytest
from fakes import FakeLLM, paper_position
from test_api import api, call, idle, ready
from test_research import stored

from app.agent.chat import Turn
from app.pipeline.report import effective_position
from app.service import ActionError


async def chat(client, service, llm, pid, calls):
    llm.chat_responses = iter(
        [
            {"role": "assistant", "tool_calls": calls},
            {"role": "assistant", "content": "Выполнено"},
        ]
    )
    await client.post(f"/api/procurements/{pid}/messages", json={"text": "Явная просьба"})
    await idle(service, pid)


async def test_correction_supersedes_and_keeps_original(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, searches):
        pid = await ready(client, service)
        for value in ["2", "5"]:
            await chat(
                client,
                service,
                llm,
                pid,
                [
                    call(
                        "correct_offer",
                        offer_id="o0",
                        field="amount",
                        value=value,
                        reason="фасовка из каталога",
                    )
                ],
            )
        edits = service.repo.edits(pid)
        assert [e.status for e in edits] == ["superseded", "active"]
        report = service.repo.get_report(pid)
        entry = next(
            e for p in report.positions for e in p.included + p.excluded if e.offer.id == "o0"
        )
        assert entry.offer.amount == 5 and entry.original["amount"] == "1"
        assert service.repo.runs(pid)[0].offers[0].offer.amount == 1
        assert len(searches) == 1


async def test_exclude_survives_rerun_and_include_cancels_exclusion(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, searches):
        pid = await ready(client, service)
        await chat(
            client,
            service,
            llm,
            pid,
            [call("exclude_offer", offer_id="o0", reason="б/у", reason_kind="other")],
        )
        await chat(client, service, llm, pid, [call("rerun_position", position_index=1)])
        assert len(searches) == 2
        assert service.repo.get_report(pid).version == 3
        assert any(
            e.offer.id == "o0" and e.exclusion == "user_excluded"
            for e in service.repo.get_report(pid).positions[0].excluded
        )
        await chat(
            client,
            service,
            llm,
            pid,
            [call("include_offer", offer_id="o0", reason="подтверждено новое")],
        )
        assert service.repo.edits(pid)[0].status == "cancelled"
        assert service.repo.get_report(pid).positions[0].status == "ok"


async def test_missing_target_reappears_and_price_reason_is_visible(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        await chat(
            client,
            service,
            llm,
            pid,
            [call("exclude_offer", offer_id="o0", reason="дорого", reason_kind="price")],
        )
        assert (
            "excluded_by_price" in service.repo.get_report(pid).positions[0].excluded[0].user_marks
        )
        assert any("по цене" in w for w in service.repo.get_report(pid).warnings)
        state = service.require(pid)
        run = service.repo.runs(pid)[0]
        missing = run.model_copy(update={"id": "missing", "offers": run.offers[1:]})
        async with service.locks[pid]:
            await service.commit(pid, service.repo.edits(pid), [missing], "Повторный поиск")
        assert not service.repo.get_report(pid).edits[0].applied
        async with service.locks[pid]:
            await service.commit(pid, service.repo.edits(pid), [run], "Повторное появление")
        assert service.repo.get_report(pid).edits[0].applied
        assert service.require(pid)["snapshot"] == state["snapshot"]


@pytest.mark.parametrize(
    "prices,field,value",
    [
        (("290", "300", "280", "1000"), None, None),
        (("290", "300", "280"), "amount_unit", "мкг"),
    ],
)
async def test_include_rejects_outlier_and_unit_mismatch(
    tmp_path, monkeypatch, prices, field, value
):
    async def search(position, adapters, llm, snapshot, emit, *, procurement_id, **kwargs):
        return stored(prices).model_copy(update={"procurement_id": procurement_id})

    async with api(tmp_path, monkeypatch, search=search) as (client, service, llm, _):
        pid = await ready(client, service)
        target = "o3" if field is None else "o0"
        if field:
            await chat(
                client,
                service,
                llm,
                pid,
                [
                    call(
                        "correct_offer",
                        offer_id=target,
                        field=field,
                        value=value,
                        reason="данные сайта",
                    )
                ],
            )
        version = service.repo.get_report(pid).version
        turn = Turn(service, pid, llm, {})
        with pytest.raises(ActionError, match="Включение невозможно"):
            await turn.include(target, "верни")
        assert service.repo.get_report(pid).version == version


async def test_cancel_one_answer_preserves_other_question_only(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        parsed = service.require(pid)["parsed"]
        second = parsed.questions[0].model_copy(update={"id": "q1-2", "text": "Какое количество?"})
        parsed.questions.append(second)
        service.repo.update(pid, parsed_json=parsed.model_dump_json())
        first_answer = paper_position(basis={"unit": "пачка", "per_tz_unit": "2"})
        second_answer = first_answer.model_copy(update={"quantity": Decimal(100)})
        turn = Turn(
            service,
            pid,
            FakeLLM(
                json_responses=[
                    first_answer.model_dump(mode="json"),
                    second_answer.model_dump(mode="json"),
                ]
            ),
            {},
        )
        await turn.answer("q1-1", "две пачки")
        await turn.answer("q1-2", "100 пачек")
        await turn.commit()
        edits = service.repo.edits(pid)
        cancel = Turn(service, pid, None, {})
        await cancel.cancel([edits[0].id])
        await cancel.commit()
        current = effective_position(parsed.positions[0], service.repo.edits(pid))
        assert current.quantity == 100 and current.basis.per_tz_unit == 1


async def test_search_finish_cannot_lose_chat_edit(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        entered, release = asyncio.Event(), asyncio.Event()

        async def search(position, adapters, llm, snapshot, emit, *, procurement_id, **kwargs):
            entered.set()
            await release.wait()
            return stored().model_copy(update={"id": "rerun", "procurement_id": procurement_id})

        monkeypatch.setattr("app.service.research_position", search)
        service.rerun(pid, [1])
        await entered.wait()
        llm.chat_responses = iter(
            [
                {
                    "role": "assistant",
                    "tool_calls": [
                        call("exclude_offer", offer_id="o0", reason="б/у", reason_kind="other")
                    ],
                },
                {"role": "assistant", "content": "Исключил"},
            ]
        )
        await client.post(f"/api/procurements/{pid}/messages", json={"text": "Исключи o0, там б/у"})
        await service.workers[pid]
        assert service.repo.get_report(pid).version == 2
        release.set()
        await idle(service, pid)
        assert service.repo.get_report(pid).version == 3
        assert service.repo.get_report(pid).edits[0].applied
        assert any(
            e.exclusion == "user_excluded"
            for e in service.repo.get_report(pid).positions[0].excluded
        )


async def test_changed_other_position_is_queued_for_research(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        state = service.require(pid)
        parsed = state["parsed"]
        parsed.positions.append(paper_position(index=2))
        parsed.questions.append(
            parsed.questions[0].model_copy(update={"id": "q2-1", "position_index": 2})
        )
        service.repo.update(pid, parsed_json=parsed.model_dump_json())
        entered, release = asyncio.Event(), asyncio.Event()
        searched = []

        async def research(position, *args, procurement_id, **kwargs):
            searched.append(position.index)
            if position.index == 1:
                entered.set()
                await release.wait()
            return stored().model_copy(
                update={
                    "id": f"run{position.index}",
                    "position_index": position.index,
                    "procurement_id": procurement_id,
                }
            )

        monkeypatch.setattr("app.service.research_position", research)
        service.rerun(pid, [1])
        await entered.wait()
        llm.json_responses = iter(
            [paper_position(index=2, name="Другая бумага").model_dump(mode="json")]
        )
        await client.post(
            f"/api/procurements/{pid}/questions/q2-1/answer", json={"answer": "другая марка"}
        )
        await service.workers[pid]
        assert service.pending_searches[pid] == {2}
        release.set()
        await idle(service, pid)
        assert searched == [1, 2]
        assert service.repo.get_report(pid).positions[1].position.name == "Другая бумага"


async def test_same_offer_id_in_two_positions_requires_position_and_edits_are_independent(
    tmp_path, monkeypatch
):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        parsed = service.require(pid)["parsed"]
        parsed.positions.append(paper_position(index=2))
        service.repo.update(pid, parsed_json=parsed.model_dump_json())
        runs = service.repo.runs(pid)
        runs.append(runs[0].model_copy(update={"id": "second", "position_index": 2}))
        async with service.locks[pid]:
            await service.commit(pid, [], runs, "Две позиции")
        turn = Turn(service, pid, llm, {})
        with pytest.raises(ActionError, match="нескольких позициях"):
            turn.get_offer("o0")
        await turn.exclude("o0", "б/у", "other", position_index=1)
        await turn.exclude("o0", "не та поставка", "other", position_index=2)
        await turn.commit()
        assert len(service.repo.get_report(pid).edits) == 2
        assert all(
            p.excluded[0].exclusion == "user_excluded"
            for p in service.repo.get_report(pid).positions
        )


async def test_viewed_version_warning_uses_state_at_commit_not_at_start(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        llm.chat_responses = iter(
            [
                {
                    "role": "assistant",
                    "tool_calls": [
                        call("exclude_offer", offer_id="o0", reason="б/у", reason_kind="other")
                    ],
                },
                {"role": "assistant", "content": "Исключил"},
            ]
        )
        original = llm.chat
        first = True

        async def delayed(messages, tools):
            nonlocal first
            if first:
                first = False
                async with service.locks[pid]:
                    await service.commit(
                        pid, [], service.repo.runs(pid), "Поиск завершился во время ответа"
                    )
            return await original(messages, tools)

        llm.chat = delayed
        await client.post(
            f"/api/procurements/{pid}/messages", json={"text": "Исключи o0", "viewing_version": 1}
        )
        await idle(service, pid)
        assert service.repo.get_report(pid).version == 3
        assert any(
            "Вы смотрели версию 1" in (m.text or "") for m in service.repo.list_messages(pid)
        )
