import argparse

from app.cli import main
from app.config import Settings


def test_cli_without_key_exits_2(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "app.cli.Settings",
        lambda: Settings(_env_file=None, data_dir=tmp_path, openrouter_api_key=None),
    )
    assert main(["run", str(tmp_path / "not-read.docx")]) == 2


async def test_cli_writes_json_docx_and_database(tmp_path, monkeypatch):
    from contextlib import asynccontextmanager

    from fakes import FakeLLM, paper_position
    from test_research import stored

    from app.cli import run
    from app.models import Report

    @asynccontextmanager
    async def runtime(*args):
        yield (
            FakeLLM(
                json_responses=[
                    {"title": "Бумага", "positions": [paper_position().model_dump(mode="json")]}
                ]
            ),
            {},
        )

    async def research(*args, procurement_id, **kwargs):
        return stored().model_copy(update={"procurement_id": procurement_id})

    monkeypatch.setattr("app.service.research_position", research)
    tz = tmp_path / "tz.txt"
    tz.write_text("ТЗ на бумагу")
    args = argparse.Namespace(
        tz=tz, timeout=10, out=tmp_path / "report.json", docx=tmp_path / "report.docx"
    )
    settings = Settings(_env_file=None, data_dir=tmp_path / "data", openrouter_api_key="test")
    assert await run(args, settings, runtime_factory=runtime) == 0
    assert Report.model_validate_json(args.out.read_text()).total is not None
    assert args.docx.read_bytes()[:2] == b"PK"
    assert settings.database_path.exists()
