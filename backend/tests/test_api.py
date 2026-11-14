import asyncio
import json
from contextlib import asynccontextmanager

from fakes import FakeLLM, paper_position
from httpx import ASGITransport, AsyncClient
from test_research import stored

from app.api.models import Procurement, QuestionMessage
from app.api.routes import event_stream
from app.config import Settings
from app.events import Event
from app.llm.client import LLMAuthError
from app.main import create_app
from app.models import ParsedTZ
from app.store.repo import new_id, now


async def test_answer_closes_legacy_duplicate_questions_and_cancel_restores_them(
    tmp_path, monkeypatch
):
    position = paper_position(
        characteristics=[{"name": "Товарный знак", "value": "SvetoCopy", "essential": True}]
    )
    raw = {
        "title": "Бумага",
        "positions": [position.model_dump(mode="json")],
        "questions": [
            {
                "position_index": 1,
                "text": "Допускается ли замена бумаги SvetoCopy на аналоги?",
                "options": ["Нет, только SvetoCopy", "Да"],
                "default_answer": "Нет, только SvetoCopy",
            }
        ],
    }
    async with api(tmp_path, monkeypatch, llm=FakeLLM([raw])) as (client, service, llm, _):
        pid = await ready(client, service)
        # Имитируем закупку, сохранённую до исправления дедупликации вопросов.
        parsed = service.require(pid)["parsed"]
        duplicate = parsed.questions[0].model_copy(
            update={"id": "q1-2", "text": "Учитывать эквиваленты SvetoCopy?"}
        )
        parsed.questions.append(duplicate)
        service.repo.update(pid, parsed_json=parsed.model_dump_json())
        await service.message(
            pid, QuestionMessage(id=new_id("m"), role="agent", created_at=now(), data=duplicate)
        )
        response = await client.post(
            f"/api/procurements/{pid}/questions/q1-1/answer", json={"answer": "Да"}
        )
        assert response.status_code == 202
        await idle(service, pid)
        messages = [m for m in service.repo.list_messages(pid) if m.kind == "question"]
        assert len(messages) == 2 and all(m.data.answer == "Да" for m in messages)
        report = service.repo.get_report(pid)
        assert all(q.answer == "Да" for q in report.questions)
        assert not report.positions[0].position.characteristics[0].essential
        assert len(llm.calls) == 1  # Разбор ТЗ; ответ кнопкой без нового LLM-запроса.
        edit_ids = [e.id for e in service.repo.edits(pid) if e.status == "active"]
        response = await client.post(
            f"/api/procurements/{pid}/edits/cancel", json={"edit_ids": edit_ids}
        )
        assert response.status_code == 202
        await idle(service, pid)
        assert all(q.answer is None for q in service.repo.get_report(pid).questions)
        assert all(
            m.data.answer is None for m in service.repo.list_messages(pid) if m.kind == "question"
        )


def call(name, **args):
    return {
        "id": f"call-{name}",
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
    }


async def idle(service, pid):
    for _ in range(500):
        tasks = [d[pid] for d in (service.workers, service.searches) if pid in d]
        if tasks and all(t.done() for t in tasks):
            for task in tasks:
                task.result()
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Фоновое задание не завершилось")


@asynccontextmanager
async def api(tmp_path, monkeypatch, *, llm=None, search=None, key="test"):
    parsed = ParsedTZ(
        title="Бумага",
        positions=[paper_position()],
        questions=[
            {
                "id": "q1-1",
                "position_index": 1,
                "text": "Какая фасовка?",
                "options": ["1", "2"],
                "default_answer": "1",
            }
        ],
    )
    raw = parsed.model_dump(mode="json")
    raw["questions"] = [
        {k: v for k, v in q.items() if k not in ("id", "answer")} for q in raw["questions"]
    ]
    llm = llm or FakeLLM(json_responses=[raw])

    @asynccontextmanager
    async def runtime(*args):
        yield llm, {1: [], 2: []}

    async def default_search(position, adapters, llm, snapshot, emit, *, procurement_id, **kwargs):
        return stored().model_copy(update={"id": str(len(calls)), "procurement_id": procurement_id})

    calls = []

    async def research(*args, **kwargs):
        calls.append(args[0].model_copy(deep=True))
        return await (search or default_search)(*args, **kwargs)

    monkeypatch.setattr("app.service.research_position", research)
    settings = Settings(
        _env_file=None, data_dir=tmp_path, config_dir=tmp_path / "config", openrouter_api_key=key
    )
    app = create_app(settings, runtime_factory=runtime)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield client, app.state.service, llm, calls


async def create(client):
    response = await client.post("/api/procurements", data={"tz_text": "ТЗ", "message": "Обоснуй"})
    assert response.status_code == 201
    return response.json()["id"]


async def ready(client, service):
    pid = await create(client)
    assert (await client.post(f"/api/procurements/{pid}/run")).status_code == 202
    await idle(service, pid)
    assert service.repo.get_report(pid) is not None
    return pid


async def test_settings_errors_uploads_and_restart(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch, key=None) as (client, service, _, _):
        pid = await create(client)
        response = await client.post(f"/api/procurements/{pid}/run")
        assert response.status_code == 400 and "ключ OpenRouter" in response.json()["detail"]
        for filename, content in [("a.xlsx", b"x"), ("a.txt", b" "), ("a.docx", b"broken")]:
            assert (
                await client.post("/api/procurements", files={"file": (filename, content)})
            ).status_code == 400
        assert (
            await client.post(
                "/api/procurements", files={"file": ("a.txt", b"x" * (20 * 1024 * 1024 + 1))}
            )
        ).status_code == 413
        assert (
            await client.post("/api/procurements", files={"file": ("a.md", "ТЗ".encode())})
        ).status_code == 201
        response = await client.post(f"/api/procurements/{pid}/messages", json={"text": " "})
        assert response.status_code == 422 and isinstance(response.json()["detail"], str)
        response = await client.put(
            "/api/settings", json={"openrouter_api_key": "secret", "model": "model"}
        )
        assert response.json() == {"has_api_key": True, "key_source": "settings", "model": "model"}
        assert "secret" not in response.text
        assert (await client.get("/api/procurements/nope")).status_code == 404
    async with api(tmp_path, monkeypatch, key="env-key") as (client, _, _, _):
        assert (await client.get("/api/settings")).json()["key_source"] == "settings"
        assert (await client.put("/api/settings", json={"openrouter_api_key": ""})).json()[
            "key_source"
        ] == "env"
        assert (await client.get(f"/api/procurements/{pid}")).status_code == 200


async def test_first_run_and_api_models(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, _, _):
        pid = await ready(client, service)
        p = Procurement.model_validate((await client.get(f"/api/procurements/{pid}")).json())
        assert p.status == "ready" and p.latest_version == 1
        assert {m.kind for m in p.messages} >= {"text", "tz_summary", "question", "run", "version"}
        assert len([m for m in p.messages if m.kind == "run"]) == 1
        assert (await client.post(f"/api/procurements/{pid}/run")).status_code == 409
        assert len((await client.get(f"/api/procurements/{pid}/reports")).json()) == 1
        assert (await client.get(f"/api/procurements/{pid}/reports/nope")).status_code == 404
        assert (await client.get("/api/procurements")).json()[0]["total"] == "725000.00"
        exported = await client.get(f"/api/procurements/{pid}/reports/1/export.docx")
        assert exported.status_code == 200 and exported.content[:2] == b"PK"
        assert "filename*=UTF-8''" in exported.headers["content-disposition"]


async def test_chat_batch_cancel_without_key_and_historical_version(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        llm.chat_responses = iter(
            [
                {
                    "role": "assistant",
                    "tool_calls": [
                        call("exclude_offer", offer_id="o0", reason="б/у", reason_kind="other"),
                        call(
                            "correct_offer",
                            offer_id="o1",
                            field="amount",
                            value="2",
                            reason="две пачки",
                        ),
                    ],
                },
                {"role": "assistant", "content": "Поправил"},
            ]
        )
        response = await client.post(
            f"/api/procurements/{pid}/messages",
            json={"text": "Исключи o0 и поправь фасовку o1", "viewing_version": 1},
        )
        assert response.status_code == 202
        await idle(service, pid)
        report = service.repo.get_report(pid)
        assert report.version == 2
        assert len(service.repo.edits(pid)) == 2
        assert any(
            e.offer.id == "o0" and e.exclusion == "user_excluded"
            for e in report.positions[0].excluded
        )
        assert service.repo.get_report(pid, 1).positions[0].status == "ok"
        card = [m for m in service.repo.list_messages(pid) if m.kind == "version"][-1]
        assert len(card.data.edit_ids) == 2 and card.data.cancellable
        assert card.data.diff.edits_added == sorted(card.data.edit_ids)
        service.settings.openrouter_api_key = None
        assert (
            await client.post(
                f"/api/procurements/{pid}/edits/cancel", json={"edit_ids": card.data.edit_ids}
            )
        ).status_code == 202
        await idle(service, pid)
        assert service.repo.get_report(pid).version == 3
        assert service.repo.get_report(pid).total == service.repo.get_report(pid, 1).total
        assert not [m for m in service.repo.list_messages(pid) if m.id == card.id][
            0
        ].data.cancellable
        assert (
            await client.post(
                f"/api/procurements/{pid}/edits/cancel", json={"edit_ids": card.data.edit_ids}
            )
        ).status_code == 409


async def test_invalid_tool_and_questions_do_not_create_version(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        llm.chat_responses = iter(
            [
                {
                    "role": "assistant",
                    "tool_calls": [
                        call("exclude_offer", offer_id="missing", reason="б/у", reason_kind="other")
                    ],
                },
                {"role": "assistant", "content": "Предложение не найдено"},
                {"role": "assistant", "tool_calls": [call("get_position", position_index=1)]},
                {"role": "assistant", "content": "Цена из найденных предложений"},
            ]
        )
        for text in ["Исключи неизвестное", "Откуда цена?"]:
            await client.post(f"/api/procurements/{pid}/messages", json={"text": text})
            await idle(service, pid)
        assert service.repo.get_report(pid).version == 1
        assert service.repo.edits(pid) == []
        results = [c for c in llm.calls if c[0] == "chat"]
        assert "не найдено" in str(results[1])


async def test_answer_during_first_search_applies_to_first_version(tmp_path, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()

    async def search(position, adapters, llm, snapshot, emit, *, procurement_id, **kwargs):
        entered.set()
        await release.wait()
        return stored().model_copy(update={"procurement_id": procurement_id})

    async with api(tmp_path, monkeypatch, search=search) as (client, service, llm, calls):
        pid = await create(client)
        await client.post(f"/api/procurements/{pid}/run")
        await asyncio.wait_for(entered.wait(), 2)
        llm.json_responses = iter([paper_position(quantity="100").model_dump(mode="json")])
        assert (
            await client.post(
                f"/api/procurements/{pid}/questions/q1-1/answer", json={"answer": "100 пачек"}
            )
        ).status_code == 202
        await service.workers[pid]
        assert service.repo.get_report(pid) is None
        assert len(service.repo.edits(pid)) == 1
        release.set()
        await idle(service, pid)
        report = service.repo.get_report(pid)
        assert report.version == 1 and report.positions[0].position.quantity == 100
        assert report.questions[0].answer == "100 пачек"
        assert len(calls) == 1  # Только количество: новый поиск не нужен.


async def test_changed_requirement_during_search_is_researched_again(tmp_path, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()

    async def search(position, adapters, llm, snapshot, emit, *, procurement_id, **kwargs):
        entered.set()
        await release.wait()
        return stored().model_copy(
            update={"id": new_id_for_test(position), "procurement_id": procurement_id}
        )

    async with api(tmp_path, monkeypatch, search=search) as (client, service, llm, calls):
        pid = await create(client)
        await client.post(f"/api/procurements/{pid}/run")
        await asyncio.wait_for(entered.wait(), 2)
        llm.json_responses = iter([paper_position(name="Другая бумага").model_dump(mode="json")])
        await client.post(
            f"/api/procurements/{pid}/questions/q1-1/answer", json={"answer": "другая марка"}
        )
        await service.workers[pid]
        release.set()
        await idle(service, pid)
        assert len(calls) == 2 and calls[-1].name == "Другая бумага"
        assert service.repo.get_report(pid).version == 1


def new_id_for_test(position):
    return "run-" + position.name


async def test_fifo_message_context_and_auth_failure_retry(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        llm.chat_responses = iter(
            [
                {"role": "assistant", "content": "Ответ 1"},
                {"role": "assistant", "content": "Ответ 2"},
            ]
        )
        await client.post(f"/api/procurements/{pid}/messages", json={"text": "Первый вопрос"})
        await client.post(f"/api/procurements/{pid}/messages", json={"text": "Второй вопрос"})
        await idle(service, pid)
        chats = [c for c in llm.calls if c[0] == "chat"]
        assert [m for m in chats[0][1] if m["role"] == "user"][-1]["content"] == "Первый вопрос"
        assert "Второй вопрос" not in str(chats[0])
        assert [m for m in chats[1][1] if m["role"] == "user"][-1]["content"] == "Второй вопрос"
    async with api(tmp_path / "auth", monkeypatch) as (client, service, llm, _):
        pid = await create(client)

        async def invalid(*args):
            raise LLMAuthError("private provider message")

        original = llm.complete_json
        llm.complete_json = invalid
        await client.post(f"/api/procurements/{pid}/run")
        await idle(service, pid)
        assert service.repo.get_procurement(pid).status == "failed"
        error = [m for m in service.repo.list_messages(pid) if m.kind == "error"][-1]
        assert error.data.code == "llm_auth" and "private" not in error.text
        llm.complete_json = original
        await client.post(f"/api/procurements/{pid}/run")
        await idle(service, pid)
        assert service.repo.get_procurement(pid).status == "ready"


async def test_sse_broadcast_and_cleanup(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, _, _):
        pid = await create(client)
        first, second = event_stream(service, pid), event_stream(service, pid)
        assert await anext(first) == await anext(second) == ": connected\n\n"
        await service.bus.publish(pid, Event(type="agent", data={"busy": True}))
        assert await anext(first) == await anext(second) == 'event: agent\ndata: {"busy": true}\n\n'
        await first.aclose()
        await second.aclose()
        assert not service.bus.subscribers


async def test_chunked_upload_limit_and_slow_sse_subscriber(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, _, _):

        async def body():
            yield (
                b'--bound\r\nContent-Disposition: form-data; name="file"; '
                b'filename="test.txt"\r\nContent-Type: text/plain\r\n\r\n'
            )
            for _ in range(22):
                yield b"x" * (1024 * 1024)
            yield b"\r\n--bound--\r\n"

        response = await client.post(
            "/api/procurements",
            content=body(),
            headers={"Content-Type": "multipart/form-data; boundary=bound"},
        )
        assert response.status_code == 413
        pid = await create(client)
        async with service.bus.subscribe(pid) as queue:
            for _ in range(257):
                await service.bus.publish(pid, Event(type="agent", data={"busy": True}))
            assert await queue.get() is None


async def test_auth_error_in_search_is_not_an_empty_report(tmp_path, monkeypatch):
    async def research(*args, **kwargs):
        raise LLMAuthError("Ключ OpenRouter недействителен")

    async with api(tmp_path, monkeypatch, search=research) as (client, service, _, _):
        pid = await create(client)
        await client.post(f"/api/procurements/{pid}/run")
        await idle(service, pid)
        assert service.repo.get_report(pid) is None
        assert service.repo.get_procurement(pid).status == "failed"
        assert [m for m in service.repo.list_messages(pid) if m.kind == "error"][
            -1
        ].data.code == "llm_auth"


async def test_source_blocked_message_carries_backend_deadline(tmp_path, monkeypatch):
    from datetime import UTC, datetime, timedelta
    from types import SimpleNamespace

    async with api(tmp_path, monkeypatch) as (client, service, _, _):
        pid = await ready(client, service)
        deadline = datetime.now(UTC) + timedelta(seconds=300)
        tab = SimpleNamespace(
            procurement_id=pid,
            id="t1",
            source_id="shop",
            name="Магазин",
            page=SimpleNamespace(url="https://shop.example/item"),
            deadline=deadline,
            wait_seconds=300,
            blocked=True,
        )
        service.browser.tabs_for = lambda _pid: [tab]
        await service.source_blocked(tab, "captcha", "waiting")
        body = (await client.get(f"/api/procurements/{pid}")).json()
        card = next(m for m in body["messages"] if m["kind"] == "source_blocked")
        assert card["data"]["wait_seconds"] == 300
        assert datetime.fromisoformat(card["data"]["deadline"]) == deadline

        tab.deadline, tab.blocked = None, False
        await service.source_blocked(tab, "captcha", "resolved")
        body = (await client.get(f"/api/procurements/{pid}")).json()
        card = next(m for m in body["messages"] if m["kind"] == "source_blocked")
        assert card["data"]["status"] == "resolved"
        assert card["data"]["deadline"] is None and card["data"]["wait_seconds"] is None
