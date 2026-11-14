"""Сетевой сбор данных; итог строится той же чистой функцией, что и пересчёт."""

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from app.config import CalculationSnapshot, policy_for
from app.events import Emit, Event, noop_emit
from app.llm.client import LLM, LLMAuthError, LLMError
from app.models import (
    CharComparison,
    DomainModel,
    FoundOffer,
    ParsedTZ,
    Position,
    Report,
    ResearchRun,
    SkippedPage,
    SourcePolicy,
    SourceRun,
)
from app.pipeline.extract import extract_offers
from app.pipeline.match import compare
from app.pipeline.report import build_position, build_report, effective_position
from app.sources.base import SourceAdapter, SourceResult, source_error
from app.tasks import gather_cancel


class ResearchResult(DomainModel):
    report: Report
    runs: list[ResearchRun]


async def research_position(
    position: Position,
    adapters: dict[int, list[SourceAdapter]],
    llm: LLM,
    snapshot: CalculationSnapshot,
    emit: Emit = noop_emit,
    *,
    procurement_id: str,
    edits=None,
    run_id: str | None = None,
) -> ResearchRun:
    position = effective_position(position, edits or [])
    run = ResearchRun(
        id=run_id or uuid4().hex,
        procurement_id=procurement_id,
        position_index=position.index,
        created_at=datetime.now(UTC),
        kind="full",
    )

    async def search(adapter):
        await emit(
            Event(
                type="progress",
                data={
                    "position_index": position.index,
                    "source_id": adapter.id,
                    "level": adapter.level,
                    "text": f"Поиск: {adapter.name}",
                },
            )
        )
        try:
            return await adapter.search(position, snapshot.rules)
        except Exception as exc:
            status, reason = source_error(exc)
            return SourceResult(
                run=SourceRun(
                    source_id=adapter.id,
                    name=adapter.name,
                    level=adapter.level,
                    position_index=position.index,
                    status=status,
                    error=reason,
                    found=0,
                    at=datetime.now(UTC),
                )
            )

    async def level(number: int):
        await emit(
            Event(
                type="progress",
                data={
                    "position_index": position.index,
                    "level": number,
                    "text": f"Поиск по уровню {number}",
                },
            )
        )
        sources = adapters.get(number, [])
        results = await gather_cancel(*(search(a) for a in sources))
        for adapter, result in zip(sources, results, strict=True):
            run.sources.append(result.run)
            run.skipped_pages.extend(result.skipped)
            for page in result.pages:
                for marker in ("неустоек не проверено", "глубина поиска по дате не проверена"):
                    if marker in page.text:
                        run.skipped_pages.append(
                            SkippedPage(
                                url=page.url,
                                source_id=adapter.id,
                                reason="Ограничение проверки ЕИС: " + marker,
                            )
                        )
                offers, failures = await extract_offers(llm, position, page, adapter)
                run.skipped_pages.extend(
                    SkippedPage(url=f.page.url, source_id=adapter.id, reason=f.reason)
                    for f in failures
                )
                if not offers and not failures:
                    run.skipped_pages.append(
                        SkippedPage(
                            url=page.url,
                            source_id=adapter.id,
                            reason="На странице не найдено предложений по позиции ТЗ",
                        )
                    )
                for offer in offers:
                    try:
                        comparison = await compare(llm, position, offer)
                    except LLMAuthError:
                        raise
                    except LLMError as exc:
                        comparison = [
                            CharComparison(
                                name=c.name, required=c.value, essential=c.essential, ok=None
                            )
                            for c in position.characteristics
                        ]
                        run.skipped_pages.append(
                            SkippedPage(
                                url=page.url,
                                source_id=adapter.id,
                                reason="Не удалось сопоставить характеристики: " + str(exc),
                            )
                        )
                    cfg = adapter.cfg
                    run.offers.append(
                        FoundOffer(
                            offer=offer,
                            comparison=comparison,
                            policy=SourcePolicy(
                                vat_default=cfg.vat_default,
                                vat_note=cfg.vat_note,
                                price_final=cfg.price_final,
                                delivery=policy_for(cfg, offer.url),
                            ),
                        )
                    )

    await level(1)
    first = build_position(position, [run], snapshot, edits)
    reason = None
    if len(first.included) < snapshot.rules.level2_trigger_min_prices:
        reason = f"на уровне 1 найдено {len(first.included)} цен"
    elif snapshot.rules.level2_on_heterogeneous and first.status == "heterogeneous":
        reason = f"выборка уровня 1 неоднородна, CV = {first.stats.cv * 100:g} %"
    if reason and adapters.get(2):
        run.assumptions.append("Уровень 2 подключён: " + reason)
        await level(2)
    return run


async def run_research(
    procurement_id: str,
    parsed: ParsedTZ,
    adapters: dict[int, list[SourceAdapter]],
    llm: LLM,
    snapshot: CalculationSnapshot,
    emit: Emit = noop_emit,
    *,
    version: int = 1,
    cause: str = "Первичный поиск",
    edits=None,
) -> ResearchResult:
    for question in parsed.questions:
        await emit(Event(type="question", data=question.model_dump(mode="json")))
    # Многопозиционные ТЗ не создают неограниченную очередь запросов LLM.
    slots = asyncio.Semaphore(3)

    async def one(position):
        async with slots:
            return await research_position(
                position, adapters, llm, snapshot, emit, procurement_id=procurement_id, edits=edits
            )

    runs = await gather_cancel(*(one(p) for p in parsed.positions))
    report = build_report(
        snapshot,
        parsed,
        runs,
        edits or [],
        version,
        cause,
        procurement_id=procurement_id,
        created_at=datetime.now(UTC),
    )
    await emit(
        Event(type="report", data={"version": version, "report": report.model_dump(mode="json")})
    )
    return ResearchResult(report=report, runs=runs)
