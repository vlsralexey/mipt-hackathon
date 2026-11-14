from decimal import Decimal

import pytest
from fakes import paper_position
from test_research import SNAP, edit, stored

from app.api.models import TextMessage
from app.models import ExcludeEdit, ParsedTZ
from app.pipeline.report import build_report
from app.store.repo import Repo, now


def seed(repo):
    pid = repo.create_procurement("Бумага", "t.docx", "ТЗ")
    parsed = ParsedTZ(title="Бумага", positions=[paper_position()])
    run = stored(("284.4102", "290", "300")).model_copy(update={"procurement_id": pid})
    repo.update(pid, parsed_json=parsed.model_dump_json(), snapshot_json=SNAP.model_dump_json())
    return pid, parsed, run


def test_version_and_raw_data_survive_restart(tmp_path):
    path = tmp_path / "db.sqlite"
    repo = Repo(path)
    pid, parsed, run = seed(repo)
    first = build_report(SNAP, parsed, [run], [], 1, "Поиск", procurement_id=pid)
    repo.commit_state(pid, runs=[run], edits=[], report=first)
    change = edit(ExcludeEdit)
    second = build_report(SNAP, parsed, [run], [change], 2, "Правка", procurement_id=pid)
    repo.commit_state(pid, runs=[run], edits=[change], report=second)
    restored = Repo(path)
    assert restored.get_report(pid, 1).model_dump_json() == first.model_dump_json()
    assert restored.get_report(pid).model_dump_json() == second.model_dump_json()
    assert restored.runs(pid)[0].offers[0].offer.price == Decimal("284.4102")
    assert restored.state(pid)["snapshot"] == SNAP
    assert [v.version for v in restored.list_versions(pid)] == [1, 2]
    assert restored.edits(pid) == [change]


def test_stale_commit_rolls_back_edits_and_runs(tmp_path):
    repo = Repo(tmp_path / "db.sqlite")
    pid, parsed, run = seed(repo)
    report = build_report(SNAP, parsed, [run], [], 1, "Поиск", procurement_id=pid)
    repo.commit_state(pid, runs=[run], edits=[], report=report)
    with pytest.raises(ValueError, match="устарела"):
        repo.commit_state(pid, runs=[], edits=[edit(ExcludeEdit)], report=report)
    assert repo.edits(pid) == []
    assert repo.runs(pid) == [run]


def test_cannot_rewrite_original_search_or_edit_payload(tmp_path):
    repo = Repo(tmp_path / "db.sqlite")
    pid, _, run = seed(repo)
    change = edit(ExcludeEdit)
    repo.commit_state(pid, runs=[run], edits=[change])
    modified = run.model_copy(deep=True)
    modified.offers[0].offer.price = Decimal("999")
    with pytest.raises(ValueError, match="неизменны"):
        repo.commit_state(pid, runs=[modified], edits=[change])
    with pytest.raises(ValueError, match="неизменно"):
        repo.commit_state(pid, runs=[run], edits=[change.model_copy(update={"reason": "иная"})])
    assert repo.runs(pid) == [run]
    assert repo.edits(pid) == [change]


def test_messages_update_in_place_and_queue_recovery(tmp_path):
    repo = Repo(tmp_path / "db.sqlite")
    pid, _, _ = seed(repo)
    message = TextMessage(id="m1", role="user", text="вопрос", created_at=now())
    repo.enqueue(pid, "chat", {"text": "вопрос"}, message)
    repo.enqueue(pid, "chat", {"text": "следующий"})
    job = repo.next_job(pid)
    assert job["payload"]["text"] == "вопрос"
    repo.save_message(pid, message.model_copy(update={"text": "обновлён"}))
    assert len(repo.list_messages(pid)) == 1
    assert repo.list_messages(pid)[0].text == "обновлён"
    repo.update(pid, status="running", agent_busy=True)
    interrupted, queued = repo.recover()
    assert interrupted == queued == [pid]
    assert repo.get_procurement(pid).status == "failed"
    assert repo.next_job(pid)["payload"]["text"] == "следующий"
    repo.set_settings({"model": "m"})
    assert Repo(repo.path).get_setting("model") == "m"
