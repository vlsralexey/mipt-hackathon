from test_api import api, ready


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
