"""Настройки меняются только после подтверждения и переживают перезапуск."""

import asyncio
from decimal import Decimal

import httpx
import pytest
from fakes import FakeLLM
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from test_api import api, call, ready

from app.config import Rules, load_rules
from app.p1.configuration import Configuration, configuration_for, execute
from app.p1.configuration_helpers import effective_snapshot, effective_sources, source_disabled
from app.p1.configuration_routes import key_http, router
from app.service import ActionError


async def configuration_client(service):
    app = FastAPI()
    app.state.service = service
    app.include_router(router)

    @app.exception_handler(ActionError)
    async def error(request: Request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    return httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test")


async def test_confirm_reject_expire_and_restart(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (_, service, _, _):
        config = configuration_for(service)
        first = await config.propose("rules.cv_threshold", "0.4", "По положению", "turn1")
        assert config.document["rules"]["cv_threshold"] == "0.33"
        with pytest.raises(ActionError, match="следующем"):
            await config.decide(first["id"], True, "turn1")
        second = await config.propose("rules.min_prices", 5, "Больше цен", "turn2")
        await config.decide(first["id"], True, "turn3")
        assert load_rules(tmp_path / "config/rules.yaml").cv_threshold == Decimal(".4")
        assert config.proposal_message(second["id"])[1].data.status == "expired"
        with pytest.raises(ActionError):
            await config.decide(second["id"], True)
        reject = await config.propose("rules.min_prices", 6, "Больше цен", "turn4")
        await config.decide(reject["id"], False)
        assert config.document["rules"]["min_prices"] == 3
        restored = Configuration(service)
        assert restored.changes() == config.changes()
        assert restored.document["rules"]["cv_threshold"] == "0.4"
        assert len(restored.messages()) == 3


async def test_invalid_change_never_mutates_and_undo_requires_fresh_confirmation(
    tmp_path, monkeypatch
):
    async with api(tmp_path, monkeypatch) as (_, service, _, _):
        config = configuration_for(service)
        with pytest.raises(ValueError):
            await config.propose("rules.min_prices", 0, "Ошибка", "t1")
        with pytest.raises(ActionError):
            await config.propose("sources.web_shops.sites", ["https://host.ru"], "Ошибка", "t1")
        assert not config.changes() and not config.messages()
        for value in (4, 5):
            proposal = await config.propose("rules.min_prices", value, "Положение", "t2")
            await config.decide(proposal["id"], True)
        old = config.changes()[0]
        pending = await config.cancel_change(old["id"])
        assert config.document["rules"]["min_prices"] == 5
        assert config.proposal_message(pending["id"])[1].data.status == "pending"
        await config.decide(pending["id"], True)
        assert config.document["rules"]["min_prices"] == 3
        assert config.changes()[0]["status"] == "cancelled"


async def test_cancel_latest_and_add_web_source(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (_, service, _, _):
        config = configuration_for(service)
        add = await config.propose(
            "sources.lab",
            {
                "id": "lab",
                "name": "Реагенты",
                "type": "web",
                "level": 1,
                "params": {"sites": ["lab.example"]},
            },
            "Для реагентов",
            "t1",
        )
        await config.decide(add["id"], True)
        assert config.config()["sources"][-1]["id"] == "lab"
        await config.cancel_change(config.changes()[-1]["id"])
        assert not any(s["id"] == "lab" for s in config.config()["sources"])
        with pytest.raises(ActionError):
            await config.propose(
                "sources.eis",
                {"id": "eis", "name": "ЕИС", "type": "eis", "level": 1},
                "Нельзя",
                "t2",
            )


async def test_config_agent_cannot_self_apply_and_queue_is_durable(tmp_path, monkeypatch):
    llm = FakeLLM(
        chat_responses=[
            {
                "role": "assistant",
                "tool_calls": [
                    call("propose_change", path="rules.min_prices", value=4, reason="Положение")
                ],
            },
            {"role": "assistant", "content": "Подтвердите изменение"},
        ]
    )
    async with api(tmp_path, monkeypatch, llm=llm) as (_, service, _, _):
        config = configuration_for(service)
        client = await configuration_client(service)
        async with client:
            response = await client.post(
                "/api/config/messages", json={"text": "Нужно минимум 4 цены"}
            )
            assert response.status_code == 202
            await config.worker
            data = (await client.get("/api/config/messages")).json()
            proposal = next(m for m in data if m["kind"] == "proposal")
            assert proposal["data"]["status"] == "pending"
            assert config.document["rules"]["min_prices"] == 3
            assert (
                await client.post(f"/api/config/proposals/{proposal['data']['id']}/apply")
            ).status_code == 202
            assert (await client.get("/api/config")).json()["rules"][0]["value"] == 4
            changes = (await client.get("/api/config/changes")).json()
            assert len(changes) == 1 and "raw_before" not in changes[0]
            assert (
                await client.post(f"/api/config/changes/{changes[0]['id']}/cancel")
            ).status_code == 202
        assert config.document["rules"]["min_prices"] == 3
        assert Configuration(service).document["jobs"][0]["status"] == "done"


async def test_local_rules_are_independent_rebase_and_reset(tmp_path, monkeypatch):
    from app.agent.chat import Turn

    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        config = configuration_for(service)
        snapshot = service.require(pid)["snapshot"].model_copy(deep=True)
        turn = Turn(service, pid, llm, {})
        candidate = await execute(
            turn,
            "change_local_setting",
            {"key": "rules.cv_threshold", "value": ".4", "reason": "223-ФЗ"},
        )
        assert not service.repo.edits(pid)
        confirm = Turn(service, pid, None, {}, origin="button")
        await service.actions.apply_into(confirm, candidate["id"])
        await confirm.commit()
        actual = effective_snapshot(snapshot, service.repo.edits(pid))
        assert actual.rules.cv_threshold == Decimal(".4")
        assert snapshot.rules.cv_threshold == Decimal(".33")
        local = config.local_settings(pid)
        changed = next(item for item in local["items"] if item["key"] == "rules.cv_threshold")
        assert changed["changed"] and changed["edit_id"]
        global_change = await config.propose("rules.min_prices", 5, "Новые общие", "t")
        await config.decide(global_change["id"], True)
        assert service.require(pid)["snapshot"].rules.min_prices == 3
        assert config.local_settings(pid)["base_outdated"]
        await config.rebase(pid)
        actual = effective_snapshot(snapshot, service.repo.edits(pid))
        assert actual.rules.min_prices == 5 and actual.rules.cv_threshold == Decimal(".4")
        assert not config.local_settings(pid)["base_outdated"]
        cancel = Turn(service, pid, None, {})
        await cancel.cancel([changed["edit_id"]])
        await cancel.commit()
        assert effective_snapshot(snapshot, service.repo.edits(pid)).rules.cv_threshold == Decimal(
            ".33"
        )


async def test_local_sources_filter_both_existing_offers_and_next_search(tmp_path, monkeypatch):
    from app.agent.chat import Turn

    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        config = configuration_for(service)
        sources = [s for s in service.require(pid)["sources"]]
        turn = Turn(service, pid, llm, {})
        turn.add(
            "local_setting",
            None,
            "sources.eis.enabled",
            {"key": "sources.eis.enabled", "value": False},
            "Не учитывать",
            "ЕИС отключён",
        )
        edits = turn.edits
        assert not effective_sources(sources, edits)[0].enabled
        offer = service.repo.runs(pid)[0].offers[0].offer.model_copy(update={"source_id": "eis"})
        assert source_disabled(offer, edits)
        assert config.validate_local(
            "sources.web_shops.sites", ["WWW.LAB.EXAMPLE", "lab.example"]
        ) == ["lab.example"]
        with pytest.raises(ActionError):
            config.validate_local("rules.methodology_note", "Нельзя")
        assert Rules().min_prices == 3


async def test_check_key_never_exposes_secret(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch, key="private-key") as (_, service, _, _):
        client = await configuration_client(service)
        app = client._transport.app

        async def http():
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda r: httpx.Response(401, json={"key": "private-key"})
                )
            ) as connection:
                yield connection

        app.dependency_overrides[key_http] = http
        async with client:
            response = await client.post("/api/settings/check")
            assert response.json() == {"ok": False, "detail": "Ключ OpenRouter недействителен"}
            assert "private-key" not in response.text


async def test_sse_publishes_settings_mutation(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (_, service, _, _):
        config = configuration_for(service)
        async with config.bus.subscribe("config") as queue:
            proposal = await config.propose("rules.min_prices", 4, "Проверка", "t")
            await config.decide(proposal["id"], True)
            events = []
            while not queue.empty():
                events.append(await asyncio.wait_for(queue.get(), 1))
        assert [event.type for event in events] == ["message", "message", "config"]
