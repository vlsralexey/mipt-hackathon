"""Прогон этапа 2 до появления API/CLI этапа 3; JSON-артефакты для проверки."""

import argparse
import asyncio
import json
from datetime import date
from pathlib import Path
from uuid import uuid4

from app.config import CalculationSnapshot, Settings, load_cpi, load_rules, load_sources
from app.events import Event
from app.llm.client import LLMError, OpenRouterLLM
from app.models import ParsedTZ
from app.pipeline.extract_text import extract_text
from app.pipeline.parse_tz import parse_tz
from app.pipeline.research import run_research
from app.sources.http import source_client
from app.sources.registry import build_adapters
from app.sources.web import OpenRouterWebSearch


def _write(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


async def preview(args):
    settings = Settings()
    key = settings.openrouter_api_key.get_secret_value() if settings.openrouter_api_key else ""
    if not key.strip():
        raise ValueError("Добавьте OPENROUTER_API_KEY в .env в корне репозитория")
    settings.prepare_directories()
    cfg = settings.effective_config_dir
    rules = load_rules(cfg / "rules.yaml")
    if args.max_pages is not None:
        rules = type(rules).model_validate(
            rules.model_dump() | {"max_pages_per_source": args.max_pages}
        )
    snapshot = CalculationSnapshot(
        calc_date=date.today(), rules=rules, cpi=load_cpi(cfg / "cpi.yaml")
    )
    args.out.mkdir(parents=True, exist_ok=True)
    async with OpenRouterLLM(key, settings.openrouter_model) as llm:
        if args.parsed:
            parsed = ParsedTZ.model_validate_json(args.parsed.read_text())
        else:
            if args.tz is None:
                raise ValueError("Нужен путь к ТЗ или --parsed")
            text = extract_text(args.tz.name, args.tz.read_bytes())
            parsed = await parse_tz(llm, text)
        if args.position:
            parsed = ParsedTZ.model_validate(
                parsed.model_dump()
                | {
                    "positions": [p for p in parsed.positions if p.index in args.position],
                    "questions": [q for q in parsed.questions if q.position_index in args.position],
                }
            )
            if not parsed.positions:
                raise ValueError("Указанные позиции отсутствуют в ТЗ")
        _write(args.out / "parsed.json", parsed.model_dump(mode="json"))
        _write(args.out / "snapshot.json", snapshot.model_dump(mode="json"))
        print(
            f"Разобрано позиций: {len(parsed.positions)}, вопросов: {len(parsed.questions)}",
            flush=True,
        )
        if args.parse_only:
            return

        async def emit(event: Event):
            if event.type == "progress":
                print(event.data.get("text", ""), flush=True)

        async with (
            source_client() as http,
            OpenRouterWebSearch(key, settings.openrouter_model) as search,
        ):
            adapters = build_adapters(load_sources(cfg / "sources.yaml"), search, http)
            result = await run_research(uuid4().hex, parsed, adapters, llm, snapshot, emit)
        _write(args.out / "report.json", result.report.model_dump(mode="json"))
        _write(args.out / "runs.json", [r.model_dump(mode="json") for r in result.runs])
        print(f"Отчёт: {args.out / 'report.json'}", flush=True)
        for pr in result.report.positions:
            print(
                f"Позиция {pr.position.index}: {pr.status}, включено {len(pr.included)}, "
                f"исключено {len(pr.excluded)}, пропусков {len(pr.skipped_pages)}",
                flush=True,
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tz", type=Path, nargs="?")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--parsed", type=Path, help="Повторить поиск по сохранённому разбору")
    parser.add_argument("--parse-only", action="store_true")
    parser.add_argument("--position", type=int, action="append")
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()

    async def bounded():
        async with asyncio.timeout(args.timeout):
            await preview(args)

    try:
        asyncio.run(bounded())
    except (LLMError, ValueError, OSError) as exc:
        parser.exit(1, f"Ошибка: {exc}\n")
    except TimeoutError:
        parser.exit(
            1, "Истекло время прогона. Сохранённый parsed.json можно использовать повторно.\n"
        )


if __name__ == "__main__":
    main()
