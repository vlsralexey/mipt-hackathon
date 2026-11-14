"""Сценарии закупки: поиск отдельно от FIFO-очереди чата, короткая блокировка записи."""

import asyncio
import logging
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime
from zoneinfo import ZoneInfo

from pydantic import TypeAdapter

from app.api.models import (
    BlockedMessage,
    ErrorData,
    ErrorMessage,
    QuestionMessage,
    RunMessage,
    RunState,
    RunStep,
    SettingsView,
    SourceBlocked,
    SummaryMessage,
    TextMessage,
    TzSummary,
    VersionCard,
    VersionMessage,
)
from app.config import CalculationSnapshot, SourceConfig, load_cpi, load_rules, load_sources
from app.events import Event, EventBus
from app.llm.client import LLMAuthError, LLMError, LLMFormatError, OpenRouterLLM
from app.p1.configuration_helpers import effective_snapshot
from app.pipeline.parse_tz import parse_tz, same_question
from app.pipeline.report import build_report, effective_position
from app.pipeline.research import research_position
from app.report.diff import version_diff
from app.sources.http import source_client
from app.sources.registry import build_adapters
from app.sources.web import OpenRouterWebSearch
from app.store.repo import new_id, now
from app.tasks import gather_cancel

logger = logging.getLogger(__name__)


def safe_text(text):
    return text.replace("—", ":").replace("–", "-") if text else text


def search_signature(position):
    # База цены, количество и существенность допускают пересчёт по сохранённым сравнениям.
    return position.name, [(c.name, c.value, c.unit) for c in position.characteristics]


@asynccontextmanager
async def open_runtime(key, model, sources, *, fetcher=None):
    async with (
        OpenRouterLLM(key, model) as llm,
        source_client() as http,
        OpenRouterWebSearch(key, model) as search,
    ):
        yield llm, build_adapters(sources, search, http, fetcher=fetcher)


class ActionError(ValueError):
    def __init__(self, detail, status=409):
        super().__init__(detail)
        self.status = status


class Service:
    def __init__(self, repo, settings, runtime_factory=open_runtime):
        self.repo, self.settings, self.runtime_factory = repo, settings, runtime_factory
        self.bus = EventBus()
        self.locks = defaultdict(asyncio.Lock)
        self.workers = {}
        self.searches = {}
        self.search_positions = {}
        self.pending_searches = defaultdict(set)
        self.closed = False
        from app.browser.manager import BrowserManager

        self.browser = BrowserManager(self.source_blocked)
        self.blocked_messages = {}
        from app.p1.actions import Actions
        from app.p1.configuration import Configuration

        self.actions = Actions(self)
        self.configuration = Configuration(self)

    @asynccontextmanager
    async def runtime(self, pid, sources):
        from app.p1.configuration_helpers import effective_sources

        sources = effective_sources(
            load_sources(self.settings.effective_config_dir / "sources.yaml"), self.repo.edits(pid)
        )
        key, model = self.require_key()
        if self.runtime_factory is open_runtime:

            async def fetcher(cfg, index, url, limit):
                return await self.browser.fetch(pid, cfg, index, url, limit)

            async with (
                self.browser.scope(pid),
                open_runtime(key, model, sources, fetcher=fetcher) as pair,
            ):
                yield pair
        else:
            async with self.runtime_factory(key, model, sources) as pair:
                yield pair

    async def source_blocked(self, tab, reason, status):
        key = (tab.procurement_id, tab.id)
        message = self.blocked_messages.get(key)
        if message is None or (status == "waiting" and message.data.status != "waiting"):
            message = BlockedMessage(
                id=new_id("m"),
                role="system",
                created_at=now(),
                data=SourceBlocked(
                    source_id=tab.source_id,
                    name=tab.name,
                    url=tab.page.url,
                    reason=reason,
                    status=status,
                ),
            )
            self.blocked_messages[key] = message
        message.data.status = status
        await self.message(tab.procurement_id, message)
        if status == "waiting":
            self.repo.update(tab.procurement_id, status="needs_user")
        elif not any(t.blocked for t in self.browser.tabs_for(tab.procurement_id)):
            self.repo.update(tab.procurement_id, status="running")
        await self.publish_summary(tab.procurement_id)

    def require(self, pid):
        state = self.repo.state(pid)
        if state is None:
            raise ActionError("Закупка не найдена", 404)
        return state

    def credentials(self):
        saved = self.repo.get_setting("openrouter_api_key") or ""
        env = self.settings.openrouter_api_key
        key = saved or (env.get_secret_value() if env else "")
        source = "settings" if saved else "env" if key.strip() else None
        model = self.repo.get_setting("model") or self.settings.openrouter_model
        return key, SettingsView(has_api_key=bool(key.strip()), key_source=source, model=model)

    def require_key(self):
        key, view = self.credentials()
        if not view.has_api_key:
            raise ActionError("Не задан ключ OpenRouter. Укажите его в настройках.", 400)
        return key, view.model

    def deterministic_answer(self, pid, question_id, answer):
        from app.pipeline.parse_tz import button_answer

        state = self.require(pid)
        parsed = state["parsed"]
        if parsed is None:
            return False
        question = next((q for q in parsed.questions if q.id == question_id), None)
        if question is None:
            return False
        base = next(p for p in parsed.positions if p.index == question.position_index)
        edits = [
            e
            for e in self.repo.edits(pid)
            if not (e.kind == "answer_question" and e.target == question_id)
        ]
        previous = effective_position(base, edits)
        return button_answer(previous, question, answer) is not None

    async def publish_summary(self, pid):
        summary = next(p for p in self.repo.list_procurements() if p.id == pid)
        await self.bus.publish(pid, Event(type="procurement", data=summary.model_dump(mode="json")))

    async def message(self, pid, message):
        if message.text:
            message.text = safe_text(message.text)
        self.repo.save_message(pid, message)
        await self.bus.publish(pid, Event(type="message", data=message.model_dump(mode="json")))

    async def text(self, pid, text):
        await self.message(
            pid, TextMessage(id=new_id("m"), created_at=now(), role="agent", text=safe_text(text))
        )

    async def error(self, pid, exc, *, parsing=False):
        if isinstance(exc, LLMAuthError):
            code, detail = "llm_auth", "Ключ OpenRouter недействителен"
        elif isinstance(exc, LLMError):
            code = (
                "tz_parse_failed"
                if parsing and isinstance(exc, LLMFormatError)
                else "llm_unavailable"
            )
            detail = str(exc)
        elif isinstance(exc, ActionError):
            await self.text(pid, str(exc))
            return
        else:
            code, detail = "internal", "Внутренняя ошибка сервера"
            logger.error("Ошибка фонового задания: %s", type(exc).__name__)
        await self.message(
            pid,
            ErrorMessage(
                id=new_id("m"),
                created_at=now(),
                role="system",
                text=detail,
                data=ErrorData(code=code),
            ),
        )

    async def start(self):
        await self.configuration.start()
        interrupted, queued = self.repo.recover()
        for pid in interrupted:
            for message in self.repo.list_messages(pid):
                if message.kind == "run" and message.data.state == "running":
                    message.data.state = "failed"
                    message.data.finished_at = now()
                    message.data.summary = "Поиск прерван перезапуском. Запустите его повторно."
                    self.repo.save_message(pid, message)
            await self.text(
                pid, "Работа прервана перезапуском. Сохранённые версии и правки доступны."
            )
        for pid in queued:
            self.kick(pid)

    async def close(self):
        self.closed = True
        tasks = list(self.workers.values()) + list(self.searches.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.browser.close()
        await self.configuration.close()

    def kick(self, pid):
        if not self.closed and (pid not in self.workers or self.workers[pid].done()):
            self.workers[pid] = asyncio.create_task(self._worker(pid))

    async def enqueue(self, pid, kind, payload, message=None):
        self.require(pid)
        self.repo.enqueue(pid, kind, payload, message)
        if message:
            await self.bus.publish(pid, Event(type="message", data=message.model_dump(mode="json")))
        self.kick(pid)

    async def _worker(self, pid):
        self.repo.update(pid, agent_busy=True)
        await self.bus.publish(pid, Event(type="agent", data={"busy": True}))
        try:
            while job := self.repo.next_job(pid):
                try:
                    from app.agent.chat import Turn, handle_message

                    state = self.require(pid)

                    @asynccontextmanager
                    async def runtime(sources=state["sources"]):
                        if job["kind"] in ("cancel", "apply_proposal", "rebase") or (
                            job["kind"] == "answer"
                            and self.deterministic_answer(pid, **job["payload"])
                        ):
                            yield None, {}
                        else:
                            async with self.runtime(pid, sources) as pair:
                                yield pair

                    async with runtime() as (llm, adapters):
                        turn = Turn(
                            self,
                            pid,
                            llm,
                            adapters,
                            origin="button" if job["kind"] != "chat" else "chat",
                        )
                        if job["kind"] == "chat":
                            await handle_message(turn, job["payload"])
                        elif job["kind"] == "answer":
                            await turn.answer(**job["payload"])
                            await turn.commit()
                        elif job["kind"] == "cancel":
                            await turn.cancel(job["payload"]["edit_ids"])
                            await turn.commit()
                        elif job["kind"] == "apply_proposal":
                            await self.actions.apply_into(turn, job["payload"]["proposal_id"])
                            await turn.commit()
                        elif job["kind"] == "rebase":
                            self.configuration.perform_rebase(turn)
                            await turn.commit()
                except Exception as exc:
                    await self.error(pid, exc)
                self.repo.finish_job(job["seq"])
        finally:
            self.repo.update(pid, agent_busy=False)
            await self.bus.publish(pid, Event(type="agent", data={"busy": False}))

    def make_report(self, pid, *, edits, runs, cause):
        state, before = self.require(pid), self.repo.get_report(pid)
        return build_report(
            state["snapshot"],
            state["parsed"],
            runs,
            edits,
            before.version + 1 if before else 1,
            safe_text(cause),
            procurement_id=pid,
            created_at=now(),
        )

    async def commit(self, pid, edits, runs, cause, *, create_version=True):
        """Вызывающий код держит locks[pid]; LLM и сеть здесь не используются."""
        before = self.repo.get_report(pid)
        report = (
            self.make_report(pid, edits=edits, runs=runs, cause=cause) if create_version else None
        )
        messages = []
        if report:
            diff = version_diff(before, report)
            messages.append(
                VersionMessage(
                    id=new_id("m"),
                    role="system",
                    created_at=report.created_at,
                    data=VersionCard(
                        version=report.version,
                        cause=report.cause,
                        diff=diff,
                        edit_ids=diff.edits_added,
                        cancellable=bool(diff.edits_added),
                    ),
                )
            )
        active_ids = {e.id for e in edits if e.status == "active"}
        for msg in self.repo.list_messages(pid):
            if msg.kind == "version" and msg.data.cancellable:
                cancellable = bool(msg.data.edit_ids) and set(msg.data.edit_ids) <= active_ids
                if not cancellable:
                    msg.data.cancellable = False
                    messages.append(msg)
            if msg.kind == "question":
                state = self.require(pid)
                original = next(q for q in state["parsed"].questions if q.id == msg.data.id)
                answer = original.answer
                for edit in edits:
                    if (
                        edit.kind == "answer_question"
                        and edit.status == "active"
                        and any(
                            q.id == edit.target and same_question(q, original)
                            for q in state["parsed"].questions
                        )
                    ):
                        answer = edit.payload.answer
                if msg.data.answer != answer:
                    msg.data.answer = answer
                    messages.append(msg)
        self.repo.commit_state(pid, edits=edits, runs=runs, report=report, messages=messages)
        if report:
            await self.actions.expire(pid, report.version)
        for message in messages:
            await self.bus.publish(pid, Event(type="message", data=message.model_dump(mode="json")))
        if report:
            await self.bus.publish(
                pid, Event(type="report", data={"version": report.version, "cause": report.cause})
            )
        await self.publish_summary(pid)
        return report

    async def start_run(self, pid):
        self.require_key()
        async with self.locks[pid]:
            state = self.require(pid)
            if pid in self.searches and not self.searches[pid].done() or self.repo.get_report(pid):
                raise ActionError(
                    "Первый прогон уже запущен или завершён. Для нового поиска напишите в чат."
                )
            cfg = self.settings.effective_config_dir
            snapshot = CalculationSnapshot(
                calc_date=datetime.now(ZoneInfo("Europe/Moscow")).date(),
                rules=load_rules(cfg / "rules.yaml"),
                cpi=load_cpi(cfg / "cpi.yaml"),
            )
            # После ошибки авторизации сохраняем уже зафиксированную базу закупки.
            snapshot = state["snapshot"] or snapshot
            sources = state["sources"] or load_sources(cfg / "sources.yaml")
            self.repo.update(
                pid,
                snapshot_json=snapshot.model_dump_json(),
                sources_json=TypeAdapter(list[SourceConfig]).dump_json(sources).decode(),
                status="running",
            )
            run_id = new_id("run")
            self.search_positions[pid] = None
            self.searches[pid] = asyncio.create_task(self._search(pid, None, run_id))
        await self.publish_summary(pid)
        return run_id

    def rerun(self, pid, indexes):
        if pid in self.searches and not self.searches[pid].done():
            active = self.search_positions.get(pid)
            if active is None or set(indexes) & (set(active) | self.pending_searches[pid]):
                raise ActionError("Поиск этой позиции уже идёт или стоит в очереди.")
            self.pending_searches[pid].update(indexes)
            return
        self.repo.update(pid, status="running")
        run_id = new_id("run")
        self.search_positions[pid] = indexes
        self.searches[pid] = asyncio.create_task(self._search(pid, indexes, run_id))

    def research_after_answer(self, pid, indexes):
        if pid in self.searches and not self.searches[pid].done():
            active = self.search_positions.get(pid)
            if active is not None:
                self.pending_searches[pid].update(set(indexes) - set(active))
        else:
            self.rerun(pid, indexes)

    async def _search(self, pid, indexes, run_id):
        message = RunMessage(
            id=new_id("m"),
            created_at=now(),
            role="system",
            data=RunState(
                run_id=run_id,
                kind="full",
                state="running",
                summary="Разбираю ТЗ" if indexes is None else "Идёт поиск",
                position_indexes=indexes or [],
                started_at=now(),
            ),
        )
        parsing = indexes is None
        try:
            await self.message(pid, message)
            state = self.require(pid)
            async with self.runtime(pid, state["sources"]) as (llm, adapters):
                parsed = state["parsed"]
                if parsed is None:
                    parsed = await parse_tz(llm, state["tz_text"])
                    self.repo.update(pid, parsed_json=parsed.model_dump_json(), title=parsed.title)
                    await self.message(
                        pid,
                        SummaryMessage(
                            id=new_id("m"),
                            role="agent",
                            created_at=now(),
                            data=TzSummary(
                                title=parsed.title,
                                positions=[
                                    {
                                        k: getattr(p, k)
                                        for k in ("index", "name", "quantity", "unit")
                                    }
                                    for p in parsed.positions
                                ],
                            ),
                        ),
                    )
                    for q in parsed.questions:
                        await self.message(
                            pid,
                            QuestionMessage(id=new_id("m"), role="agent", created_at=now(), data=q),
                        )
                    await self.publish_summary(pid)
                parsing = False
                positions = [p for p in parsed.positions if indexes is None or p.index in indexes]
                message.data.position_indexes = [p.index for p in positions]
                message.data.summary = "Идёт поиск"
                message.data.steps = [
                    RunStep(
                        source_id=a.id,
                        name=a.name,
                        level=a.level,
                        position_index=p.index,
                        status="queued",
                        found=0,
                    )
                    for p in positions
                    for group in adapters.values()
                    for a in group
                ]
                await self.message(pid, message)

                async def emit(event):
                    if event.type != "progress":
                        return
                    for step in message.data.steps:
                        if step.position_index == event.data.get(
                            "position_index"
                        ) and step.source_id == event.data.get("source_id"):
                            step.status = "running"
                    await self.message(pid, message)

                slots = asyncio.Semaphore(3)

                async def one(base):
                    async with slots:
                        while True:
                            edits = self.repo.edits(pid)
                            current = effective_position(base, edits)
                            result = await research_position(
                                current,
                                adapters,
                                llm,
                                effective_snapshot(state["snapshot"], edits),
                                emit,
                                procurement_id=pid,
                                edits=edits,
                            )
                            if search_signature(current) == search_signature(
                                effective_position(base, self.repo.edits(pid))
                            ):
                                return current, result

                searched = dict(
                    zip(
                        [p.index for p in positions],
                        await gather_cancel(*(one(p) for p in positions)),
                        strict=True,
                    )
                )
                # Изменение позиции во время поиска другой позиции также требует проверки.
                while True:
                    async with self.locks[pid]:
                        edits = self.repo.edits(pid)
                        stale = [
                            p
                            for p in positions
                            if search_signature(effective_position(p, edits))
                            != search_signature(searched[p.index][0])
                        ]
                        if not stale:
                            results = [searched[p.index][1] for p in positions]
                            old_runs = [
                                r
                                for r in self.repo.runs(pid)
                                if r.kind == "user"
                                or r.position_index not in message.data.position_indexes
                            ]
                            report = await self.commit(
                                pid,
                                edits,
                                old_runs + results,
                                "Первый прогон"
                                if self.repo.get_report(pid) is None
                                else "Повторный поиск",
                            )
                            self.repo.update(pid, status="ready")
                            break
                    refreshed = await gather_cancel(*(one(p) for p in stale))
                    searched.update(zip([p.index for p in stale], refreshed, strict=True))
                for step in message.data.steps:
                    source = next(
                        (
                            s
                            for r in results
                            for s in r.sources
                            if s.source_id == step.source_id
                            and s.position_index == step.position_index
                        ),
                        None,
                    )
                    step.status = source.status if source else "skipped"
                    step.found = source.found if source else 0
                    step.relevant = sum(
                        e.offer.source_id == step.source_id
                        for p in report.positions
                        if p.position.index == step.position_index
                        for e in p.included
                    )
                    step.note = (
                        safe_text(source.error)
                        if source
                        else "Поиск на этом уровне не потребовался"
                    )
                message.data.state = "done"
                message.data.summary = (
                    f"Проверено {len(report.sources)} источников, "
                    f"подходят {sum(len(p.included) for p in report.positions)} цен"
                )
        except Exception as exc:
            await self.error(pid, exc, parsing=parsing)
            self.repo.update(pid, status="ready" if self.repo.get_report(pid) else "failed")
            message.data.state = "failed"
            message.data.summary = "Поиск не завершён"
        finally:
            message.data.finished_at = now()
            await self.message(pid, message)
            await self.publish_summary(pid)
            pending = sorted(self.pending_searches.pop(pid, set()))
            if pending and not self.closed and message.data.state == "done":
                self.repo.update(pid, status="running")
                self.search_positions[pid] = pending
                self.searches[pid] = asyncio.create_task(self._search(pid, pending, new_id("run")))
