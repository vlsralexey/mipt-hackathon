"""Подтверждения, дополнительные поиски и инструменты чтения закупки.

Предпросмотр и payload сохраняются в SQLite. Применение проходит через ту же
очередь, что и чат, и никогда не вызывает LLM для подтверждения кнопкой.
"""

import copy
import json
from datetime import datetime
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from pydantic import TypeAdapter

from app.api.models import ProposalMessage, RunMessage, RunState
from app.api.routes import Dep, get_report
from app.config import SourceConfig
from app.models import (
    Edit,
    EditPositionPayload,
    ExcludeWherePayload,
    FoundOffer,
    OfferFilter,
    Proposal,
    ResearchRun,
    SourcePolicy,
    SourceRun,
    VersionDiff,
)
from app.p1.configuration_helpers import effective_snapshot
from app.p1.filters import matches
from app.pipeline.extract import extract_offers
from app.pipeline.match import compare
from app.pipeline.report import effective_position
from app.pipeline.research import research_position
from app.report.diff import version_diff
from app.service import ActionError, open_runtime, search_signature
from app.sources.fetch import fetch_page, public_url
from app.sources.http import source_client
from app.store.repo import new_id, now

EDITS = TypeAdapter(list[Edit])
router = APIRouter(prefix="/api/procurements")


def schemas(tool, string, index):
    filters = OfferFilter.model_json_schema()
    # Tool API принимает только JSON Schema; модели фильтра не имеют вложенных $defs.
    return [
        tool(
            "find_offers",
            "Найти предложения по условиям через И",
            {"position_index": index, "filter": filters},
            ["filter"],
        ),
        tool("list_edits", "Все правки закупки и их состояния"),
        tool(
            "restart_research",
            "Предложить полный поиск всех позиций с сегодняшней датой расчёта, сохранив правки",
        ),
        tool(
            "diff_versions",
            "Рассчитанная кодом разница двух сохранённых версий",
            {"a": index, "b": index},
            ["a", "b"],
        ),
        tool(
            "exclude_where",
            "Предложить массовое исключение через подтверждение",
            {"position_index": index, "filter": filters, "reason": string},
            ["filter", "reason"],
        ),
        tool(
            "edit_position",
            "Изменить quantity, name, essential:<имя> или characteristic:<имя>",
            {
                "position_index": index,
                "field": string,
                "value": {"type": ["string", "boolean"]},
                "reason": string,
            },
            ["position_index", "field", "value", "reason"],
        ),
        tool(
            "revert_to_version",
            "Предложить восстановление данных и правок сохранённой версии",
            {"version": index},
            ["version"],
        ),
        tool(
            "apply_proposal",
            "Применить предложение только из предыдущего хода после согласия пользователя",
            {"proposal_id": string},
            ["proposal_id"],
        ),
        tool(
            "search_more",
            "Дополнительный поиск без удаления прежних результатов",
            {
                "position_index": index,
                "levels": {
                    "type": "array",
                    "items": {"type": "integer", "enum": [1, 2]},
                    "minItems": 1,
                    "uniqueItems": True,
                },
                "site": string,
                "query": string,
            },
            ["position_index"],
        ),
        tool(
            "add_offer_from_url",
            "Загрузить настоящую страницу и добавить извлечённые предложения",
            {"position_index": index, "url": string},
            ["position_index", "url"],
        ),
        tool(
            "skip_source",
            "Пропустить источник, ожидающий входа или капчи",
            {"source_id": string},
            ["source_id"],
        ),
    ]


def actions_for(service):
    if not hasattr(service, "actions"):
        service.actions = Actions(service)
    return service.actions


class Actions:
    def __init__(self, service):
        self.service, self.repo = service, service.repo
        self.applying = set()
        with self.repo.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS procurement_proposals (
                id TEXT PRIMARY KEY, procurement_id TEXT NOT NULL,
                message_id TEXT NOT NULL, turn_id TEXT NOT NULL,
                base_version INTEGER NOT NULL, payload TEXT NOT NULL,
                FOREIGN KEY(procurement_id) REFERENCES procurements(id))""")

    def _row(self, pid, proposal_id):
        self.service.require(pid)
        with self.repo.connect() as db:
            row = db.execute(
                "SELECT * FROM procurement_proposals WHERE id=? AND procurement_id=?",
                (proposal_id, pid),
            ).fetchone()
        if row is None:
            raise ActionError("Предложение подтверждения не найдено", 404)
        row = dict(row)
        row["payload"] = json.loads(row["payload"])
        message = next((m for m in self.repo.list_messages(pid) if m.id == row["message_id"]), None)
        if message is None:
            raise ActionError("Карточка подтверждения не найдена", 404)
        row["message"] = message
        return row

    def pending(self, pid, proposal_id):
        row = self._row(pid, proposal_id)
        report = self.repo.get_report(pid)
        base_edits = row["payload"].get("base_edits")
        edits_changed = base_edits is not None and base_edits != EDITS.dump_python(
            self.repo.edits(pid), mode="json"
        )
        base_runs = row["payload"].get("base_run_ids")
        runs_changed = base_runs is not None and base_runs != [
            run.id for run in self.repo.runs(pid)
        ]
        if (
            row["message"].data.status != "pending"
            or report is None
            or row["base_version"] != report.version
            or edits_changed
            or runs_changed
        ):
            raise ActionError(
                "Подтверждение уже применено, отменено или устарело. Попросите новый предпросмотр."
            )
        return row

    async def propose(self, turn, edits, text, runs=None, restore=None, restart=False):
        report = self.repo.get_report(turn.pid)
        if report is None:
            raise ActionError("Подтверждение доступно после первого отчёта")
        # Внутри хода учитываем все его ещё не сохранённые изменения.
        runs = runs if runs is not None else turn.current_runs()
        preview = self.service.make_report(turn.pid, edits=edits, runs=runs, cause=text)
        proposal = Proposal(
            id=new_id("pr"), text=text, diff=version_diff(report, preview), status="pending"
        )
        message = ProposalMessage(id=new_id("m"), created_at=now(), role="agent", data=proposal)
        payload = {
            "edits": EDITS.dump_python(edits, mode="json"),
            "run_ids": [r.id for r in runs],
            "restore": restore,
            "base_edits": EDITS.dump_python(self.repo.edits(turn.pid), mode="json"),
            "base_run_ids": [run.id for run in self.repo.runs(turn.pid)],
            "restart": restart,
        }
        with self.repo.connect() as db:
            db.execute(
                "INSERT INTO procurement_proposals VALUES(?,?,?,?,?,?)",
                (
                    proposal.id,
                    turn.pid,
                    message.id,
                    turn.turn_id,
                    report.version,
                    json.dumps(payload, ensure_ascii=False),
                ),
            )
            self.repo._message(db, turn.pid, message)
        await self.service.bus.publish(turn.pid, self._message_event(message))
        return proposal.model_dump(mode="json")

    @staticmethod
    def _message_event(message):
        from app.events import Event

        return Event(type="message", data=message.model_dump(mode="json"))

    async def expire(self, pid, version):
        with self.repo.connect() as db:
            ids = [
                r[0]
                for r in db.execute(
                    "SELECT id FROM procurement_proposals "
                    "WHERE procurement_id=? AND base_version<>?",
                    (pid, version),
                )
            ]
        for proposal_id in ids:
            row = self._row(pid, proposal_id)
            if row["message"].data.status == "pending" and proposal_id not in self.applying:
                row["message"].data.status = "expired"
                await self.service.message(pid, row["message"])

    async def reject(self, pid, proposal_id):
        async with self.service.locks[pid]:
            row = self.pending(pid, proposal_id)
            row["message"].data.status = "rejected"
            await self.service.message(pid, row["message"])

    async def apply_into(self, turn, proposal_id):
        row = self.pending(turn.pid, proposal_id)
        if row["turn_id"] == turn.turn_id:
            raise ActionError(
                "Нельзя подтвердить предложение в том же ходе. Дождитесь согласия пользователя."
            )
        if turn.changed:
            raise ActionError(
                "Сначала завершите текущие правки, затем запросите новый предпросмотр"
            )
        if row["payload"].get("restart"):
            self.service.require_key()
            self.ensure_not_searching(turn.pid)
            turn.restart_search = True
            turn.answer_search_indexes.update(p.index for p in turn.state["parsed"].positions)
        turn.edits = EDITS.validate_python(row["payload"]["edits"])
        if row["payload"].get("restore"):
            turn.restore_runs = self.version_runs(turn.pid, row["payload"]["restore"])
            old_positions = {
                p.index: effective_position(p, self.repo.edits(turn.pid))
                for p in turn.state["parsed"].positions
            }
            changed = [
                p.index
                for p in turn.state["parsed"].positions
                if search_signature(old_positions[p.index])
                != search_signature(effective_position(p, turn.edits))
            ]
            # Версия уже хранит соответствующие прежней формулировке результаты.
            if changed:
                turn.causes.append("Восстановлены результаты поиска выбранной версии")
        turn.changed = True
        turn.causes.append(row["message"].data.text)
        turn.applied_proposals.append(proposal_id)
        return {"detail": "Подтверждение будет применено в конце хода"}

    async def mark_applied(self, pid, proposal_id):
        row = self._row(pid, proposal_id)
        row["message"].data.status = "applied"
        await self.service.message(pid, row["message"])
        self.applying.discard(proposal_id)

    def version_runs(self, pid, version):
        with self.repo.connect() as db:
            row = db.execute(
                "SELECT run_ids FROM report_versions WHERE procurement_id=? AND version=?",
                (pid, version),
            ).fetchone()
            if row is None:
                raise ActionError("Версия отчёта не найдена", 404)
            ids = json.loads(row[0])
            result = []
            for rid in ids:
                body = db.execute(
                    "SELECT body FROM research_runs WHERE id=? AND procurement_id=?", (rid, pid)
                ).fetchone()
                if body is None:
                    raise ActionError("Исходные данные версии не найдены", 404)
                result.append(ResearchRun.model_validate_json(body[0]))
        return result

    def ensure_not_searching(self, pid):
        if pid in self.service.searches and not self.service.searches[pid].done():
            raise ActionError("Дождитесь завершения текущего поиска перед полным перезапуском")

    async def execute(self, turn, name, args):
        if name == "restart_research":
            self.service.require_key()
            self.ensure_not_searching(turn.pid)
            snapshot = effective_snapshot(turn.state["snapshot"], turn.edits)
            today = datetime.now(ZoneInfo("Europe/Moscow")).date()
            temp = copy.copy(turn)
            temp.edits, temp.causes = copy.deepcopy(turn.edits), []
            text = (
                "Начать полный поиск всех позиций заново, сохранив ваши правки. "
                f"Дата расчёта: {today:%d.%m.%Y}. "
                "Предпросмотр пересчитывает сохранённые цены; после поиска итог может измениться."
            )
            temp.add(
                "rebase_settings",
                None,
                "base",
                {
                    "rules": snapshot.rules.model_dump(mode="json"),
                    "cpi": snapshot.cpi,
                    "calc_date": today,
                },
                text,
                text,
            )
            return await self.propose(turn, temp.edits, text, restart=True)
        if name == "find_offers":
            payload = ExcludeWherePayload.model_validate(args)
            return [
                {"position_index": p.position.index, **e.model_dump(mode="json")}
                for p in turn.report().positions
                if payload.position_index in (None, p.position.index)
                for e in p.included + p.excluded
                if matches(e, payload.filter)
            ]
        if name == "list_edits":
            return EDITS.dump_python(turn.edits, mode="json")
        if name == "diff_versions":
            before = get_report(self.service, turn.pid, str(args["a"]))
            after = get_report(self.service, turn.pid, str(args["b"]))
            return version_diff(before, after).model_dump(mode="json")
        if name == "exclude_where":
            payload = ExcludeWherePayload.model_validate(
                {k: v for k, v in args.items() if k != "reason"}
            )
            if not payload.filter.model_dump(exclude_defaults=True):
                raise ActionError("Для массового исключения укажите хотя бы одно условие", 400)
            reason = args["reason"]
            temp = copy.copy(turn)
            temp.edits, temp.causes = copy.deepcopy(turn.edits), []
            price = (
                payload.filter.normalized_price_above is not None
                or payload.filter.normalized_price_below is not None
            )
            temp.add(
                "exclude_where",
                payload.position_index,
                None,
                payload.model_dump(),
                reason,
                "Исключение предложений по условию: " + reason,
                "price" if price else "other",
            )
            return await self.propose(turn, temp.edits, temp.causes[-1])
        if name == "edit_position":
            position = turn.get_position(args["position_index"]).position
            payload = EditPositionPayload(field=args["field"], value=args["value"])
            # Проверяем полный результат, а не только тип входного значения.
            temp = copy.copy(turn)
            temp.edits, temp.causes = copy.deepcopy(turn.edits), []
            temp.add(
                "edit_position",
                position.index,
                payload.field,
                payload.model_dump(),
                args["reason"],
                f"Изменена позиция {position.index}: {payload.field}",
            )
            new_position = effective_position(
                next(p for p in turn.state["parsed"].positions if p.index == position.index),
                temp.edits,
            )
            if search_signature(position) != search_signature(new_position):
                self.service.require_key()
                turn.answer_search_indexes.add(position.index)
            turn.edits, turn.changed = temp.edits, True
            turn.causes.extend(temp.causes)
            return {"detail": temp.causes[-1]}
        if name == "revert_to_version":
            version = args["version"]
            target = get_report(self.service, turn.pid, str(version))
            current = self.repo.get_report(turn.pid)
            if current.version == version:
                raise ActionError("Эта версия уже последняя")
            with self.repo.connect() as db:
                body = db.execute(
                    "SELECT edits_json FROM report_versions WHERE procurement_id=? AND version=?",
                    (turn.pid, version),
                ).fetchone()[0]
            selected = EDITS.validate_json(body)
            selected_ids = {e.id: e for e in selected}
            restored = [
                e.model_copy(
                    update={
                        "status": selected_ids[e.id].status if e.id in selected_ids else "cancelled"
                    }
                )
                for e in self.repo.edits(turn.pid)
            ]
            text = f"Восстановить данные и правки версии {target.version} новой версией отчёта"
            return await self.propose(
                turn, restored, text, runs=self.version_runs(turn.pid, version), restore=version
            )
        if name == "apply_proposal":
            return await self.apply_into(turn, args["proposal_id"])
        if name == "search_more":
            return await self.search_more(turn, **args)
        if name == "add_offer_from_url":
            return await self.add_url(turn, **args)
        if name == "skip_source":
            if not hasattr(self.service, "browser"):
                raise ActionError("Источник сейчас не ожидает действий пользователя")
            return await self.service.browser.skip_source(turn.pid, args["source_id"])
        from app.p1.configuration import execute

        return await execute(turn, name, args)

    async def search_more(self, turn, position_index, levels=None, site=None, query=None):
        position = turn.get_position(position_index).position
        self.service.require_key()
        if site:
            host = urlsplit(public_url(site if "://" in site else "https://" + site)).hostname
            if not host:
                raise ActionError("Укажите домен сайта", 400)
            site = host.removeprefix("www.")
        adapters = {}
        for level, group in turn.adapters.items():
            if levels and level not in levels:
                continue
            for adapter in group:
                if (site or query) and adapter.cfg.type != "web":
                    continue
                clone = copy.copy(adapter)
                clone.cfg = adapter.cfg.model_copy(deep=True)
                if site:
                    clone.cfg.params["sites"] = [site]
                if query:
                    clone.cfg.params["query_suffix"] = query
                # Переносим выбранные источники на уровень 1: targeted не должен
                # прекращаться после достаточной выборки первого источника.
                adapters.setdefault(1, []).append(clone)
        if not any(adapters.values()):
            raise ActionError("Для указанного запроса нет включённых источников", 400)
        message = RunMessage(
            id=new_id("m"),
            created_at=now(),
            role="system",
            data=RunState(
                run_id=new_id("run"),
                kind="targeted",
                state="running",
                summary=f"Дополнительный поиск позиции {position_index}",
                position_indexes=[position_index],
                started_at=now(),
            ),
        )
        await self.service.message(turn.pid, message)
        try:
            run = await research_position(
                position,
                adapters,
                turn.llm,
                effective_snapshot(turn.state["snapshot"], turn.edits),
                self.service.page_events(turn.pid),
                procurement_id=turn.pid,
                edits=turn.edits,
            )
            run.kind = "targeted"
            turn.extra_runs.append(run)
            turn.changed = True
            turn.causes.append(f"Дополнительный поиск позиции {position_index}")
            message.data.state, message.data.summary = (
                "done",
                f"Дополнительный поиск: найдено предложений {len(run.offers)}",
            )
        except BaseException:
            message.data.state, message.data.summary = "failed", "Дополнительный поиск не завершён"
            raise
        finally:
            message.data.finished_at = now()
            await self.service.message(turn.pid, message)
        return {"detail": message.data.summary, "run_id": run.id}

    async def add_url(self, turn, position_index, url):
        url = public_url(url)
        position = turn.get_position(position_index).position
        self.service.require_key()
        source = type("UserSource", (), {})()
        source.cfg = SourceConfig(id="user", name="Ссылка пользователя", level=1, type="web")
        source.id, source.name, source.level = source.cfg.id, source.cfg.name, source.cfg.level
        limit = turn.state["snapshot"].rules.page_text_limit
        if self.service.runtime_factory is open_runtime:
            page = await self.service.browser.fetch(
                turn.pid, source.cfg, position_index, url, limit
            )
        else:
            async with source_client() as http:
                page = await fetch_page(http, url, limit)
        offers, failures = await extract_offers(turn.llm, position, page, source)
        if not offers:
            raise ActionError(
                "Не удалось извлечь предложение: "
                + (failures[0].reason if failures else "на странице нет цены"),
                400,
            )
        found = [
            FoundOffer(
                offer=offer,
                comparison=await compare(turn.llm, position, offer),
                policy=SourcePolicy(),
            )
            for offer in offers
        ]
        at = now()
        run = ResearchRun(
            id=new_id("run"),
            procurement_id=turn.pid,
            position_index=position_index,
            created_at=at,
            kind="user",
            offers=found,
            sources=[
                SourceRun(
                    source_id=source.id,
                    name=source.name,
                    level=1,
                    position_index=position_index,
                    status="ok",
                    found=len(offers),
                    queries=[url],
                    at=at,
                )
            ],
        )
        turn.extra_runs.append(run)
        turn.add(
            "add_offer",
            position_index,
            run.id,
            {"run_id": run.id},
            "Ссылка пользователя: " + url,
            f"Добавлено предложений по ссылке: {len(offers)}",
        )
        return {"detail": turn.causes[-1], "offers": [o.model_dump(mode="json") for o in offers]}


@router.get("/{pid}/reports/{a}/diff/{b}", response_model=VersionDiff)
async def diff(pid: str, a: int, b: int, service: Dep):
    return version_diff(get_report(service, pid, str(a)), get_report(service, pid, str(b)))


@router.post("/{pid}/proposals/{proposal_id}/apply", status_code=202)
async def apply(pid: str, proposal_id: str, service: Dep):
    actions_for(service).pending(pid, proposal_id)
    await service.enqueue(pid, "apply_proposal", {"proposal_id": proposal_id})
    return {}


@router.post("/{pid}/proposals/{proposal_id}/reject")
async def reject(pid: str, proposal_id: str, service: Dep):
    await actions_for(service).reject(pid, proposal_id)
    return {}
