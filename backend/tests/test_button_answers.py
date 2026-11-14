import json

from fakes import FakeLLM, paper_position
from test_api import api, call, idle, ready


async def test_default_button_answer_applies_without_key_or_llm(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        service.settings.openrouter_api_key = None
        calls = len(llm.calls)
        response = await client.post(
            f"/api/procurements/{pid}/questions/q1-1/answer", json={"answer": "1"}
        )
        assert response.status_code == 202
        await service.workers[pid]
        assert service.repo.get_report(pid).questions[0].answer == "1"
        assert len(llm.calls) == calls


async def test_repeated_same_button_answer_creates_no_edit_or_version(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        url = f"/api/procurements/{pid}/questions/q1-1/answer"
        assert (await client.post(url, json={"answer": "1"})).status_code == 202
        await idle(service, pid)
        edits, version = service.repo.edits(pid), service.repo.get_report(pid).version
        messages = len(service.repo.list_messages(pid))
        assert (await client.post(url, json={"answer": " 1 "})).status_code == 202
        await idle(service, pid)
        assert service.repo.edits(pid) == edits
        assert service.repo.get_report(pid).version == version
        assert len(service.repo.list_messages(pid)) == messages


async def test_repeated_same_model_answer_needs_no_key(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        url = f"/api/procurements/{pid}/questions/q1-1/answer"
        llm.json_responses = iter([paper_position().model_dump(mode="json")])
        assert (await client.post(url, json={"answer": "2"})).status_code == 202
        await idle(service, pid)
        edits = service.repo.edits(pid)
        service.settings.openrouter_api_key = None
        assert (await client.post(url, json={"answer": "2"})).status_code == 202
        await idle(service, pid)
        assert service.repo.edits(pid) == edits


async def test_repeated_same_answer_from_chat_creates_no_version(tmp_path, monkeypatch):
    async with api(tmp_path, monkeypatch) as (client, service, llm, _):
        pid = await ready(client, service)
        url = f"/api/procurements/{pid}/questions/q1-1/answer"
        assert (await client.post(url, json={"answer": "1"})).status_code == 202
        await idle(service, pid)
        edits, version = service.repo.edits(pid), service.repo.get_report(pid).version
        llm.chat_responses = iter(
            [
                {
                    "role": "assistant",
                    "tool_calls": [call("answer_question", question_id="q1-1", answer="1")],
                },
                {"role": "assistant", "content": "Ответ уже действует"},
            ]
        )
        await client.post(f"/api/procurements/{pid}/messages", json={"text": "Фасовка 1"})
        await idle(service, pid)
        assert service.repo.edits(pid) == edits
        assert service.repo.get_report(pid).version == version
        tool_result = [c for c in llm.calls if c[0] == "chat"][-1]
        assert "уже" in str(tool_result)


def downgrade_question_options(service, pid, options):
    """Записывает варианты вопроса в обход моделей, как в закупке до исправления."""
    with service.repo.connect() as db:
        (parsed,) = db.execute("SELECT parsed_json FROM procurements WHERE id=?", (pid,)).fetchone()
        data = json.loads(parsed)
        data["questions"][0]["options"] = options
        db.execute("UPDATE procurements SET parsed_json=? WHERE id=?", (json.dumps(data), pid))
        for mid, body in db.execute("SELECT id, body FROM messages").fetchall():
            message = json.loads(body)
            if message["kind"] == "question":
                message["data"]["options"] = options
                db.execute("UPDATE messages SET body=? WHERE id=?", (json.dumps(message), mid))


async def test_legacy_single_option_analog_question_is_shown_and_applied_without_llm(
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
                "text": "Есть ли аналоги товару с торговой маркой SvetoCopy?",
                "options": ["Нет, только SvetoCopy", "Да, учитывать аналоги"],
                "default_answer": "Нет, только SvetoCopy",
            }
        ],
    }
    async with api(tmp_path, monkeypatch, llm=FakeLLM([raw])) as (client, service, llm, _):
        pid = await ready(client, service)
        downgrade_question_options(service, pid, ["Нет, только SvetoCopy"])
        procurement = (await client.get(f"/api/procurements/{pid}")).json()
        shown = next(m["data"] for m in procurement["messages"] if m["kind"] == "question")
        assert shown["options"] == ["Нет, только SvetoCopy", "Да, учитывать аналоги"]
        service.settings.openrouter_api_key = None
        calls = len(llm.calls)
        response = await client.post(
            f"/api/procurements/{pid}/questions/q1-1/answer",
            json={"answer": "Да, учитывать аналоги"},
        )
        assert response.status_code == 202
        await idle(service, pid)
        report = service.repo.get_report(pid)
        assert report.questions[0].answer == "Да, учитывать аналоги"
        assert not report.positions[0].position.characteristics[0].essential
        assert len(llm.calls) == calls
