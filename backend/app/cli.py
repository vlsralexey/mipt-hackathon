"""CLI того же сценария, что REST: SQLite, отчёт JSON и экспорт DOCX."""

import argparse
import asyncio
import sys
from pathlib import Path

from app.api.models import FileData, FileMessage
from app.config import Settings
from app.pipeline.extract_text import extract_text
from app.report.docx_export import render_docx
from app.service import Service
from app.store.repo import Repo, new_id, now


async def run(args, settings, *, runtime_factory=None):
    settings.prepare_directories()
    kwargs = {"runtime_factory": runtime_factory} if runtime_factory else {}
    service = Service(Repo(settings.database_path), settings, **kwargs)
    if not service.credentials()[1].has_api_key:
        print("Не задан ключ OpenRouter. Укажите его в настройках или окружении.", file=sys.stderr)
        return 2
    data = args.tz.read_bytes()
    content = extract_text(args.tz.name, data)
    pid = service.repo.create_procurement(
        args.tz.stem,
        args.tz.name,
        content,
        [
            FileMessage(
                id=new_id("m"),
                created_at=now(),
                role="user",
                data=FileData(filename=args.tz.name, size_bytes=len(data)),
            )
        ],
    )
    print(f"Закупка: {pid}", flush=True)
    try:
        async with service.bus.subscribe(pid) as queue:
            await service.start_run(pid)

            async def progress():
                while True:
                    event = await queue.get()
                    if event is None:
                        return
                    if event.type == "message" and event.data["kind"] in ("run", "error"):
                        print(
                            event.data["text"] or event.data["data"].get("summary", ""), flush=True
                        )

            printer = asyncio.create_task(progress())
            try:
                async with asyncio.timeout(args.timeout):
                    await service.searches[pid]
            finally:
                printer.cancel()
                await asyncio.gather(printer, return_exceptions=True)
        report = service.repo.get_report(pid)
        if report is None:
            return 1
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
        if args.docx:
            args.docx.parent.mkdir(parents=True, exist_ok=True)
            args.docx.write_bytes(render_docx(report))
        for p in report.positions:
            print(
                f"Позиция {p.position.index}: {p.status}, "
                f"цен {len(p.included)}, НМЦК {p.unit_price}"
            )
        print(f"Итог: {report.total}; обоснованная часть: {report.total_justified}")
        return 0
    finally:
        await service.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    command = sub.add_parser("run", help="Обосновать НМЦК по ТЗ")
    command.add_argument("tz", type=Path)
    command.add_argument("--out", type=Path)
    command.add_argument("--docx", type=Path)
    command.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args(argv)
    try:
        return asyncio.run(run(args, Settings()))
    except (ValueError, OSError):
        print(
            "Не удалось прочитать ТЗ или записать результат. Проверьте формат и пути.",
            file=sys.stderr,
        )
        return 1
    except TimeoutError:
        print("Истекло время поиска. Данные закупки сохранены.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
