import asyncio
import json
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import Response, StreamingResponse

from app.api.models import (
    AnswerInput,
    CancelInput,
    FileData,
    FileMessage,
    Message,
    MessageInput,
    OpenRouterModel,
    Procurement,
    ProcurementSummary,
    SettingsUpdate,
    SettingsView,
    TextMessage,
    VersionInfo,
)
from app.llm.catalog import CatalogError, fetch_models
from app.models import Edit, Report
from app.pipeline.extract_text import MAX_FILE_BYTES, extract_text
from app.service import ActionError, Service
from app.store.repo import new_id, now

router = APIRouter(prefix="/api")


def get_service(request: Request) -> Service:
    return request.app.state.service


Dep = Annotated[Service, Depends(get_service)]


@router.get("/settings", response_model=SettingsView)
async def settings(service: Dep):
    return service.credentials()[1]


async def get_catalog_http():
    async with httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5)) as http:
        yield http


@router.get("/settings/models", response_model=list[OpenRouterModel])
async def models(http: Annotated[httpx.AsyncClient, Depends(get_catalog_http)]):
    try:
        return await fetch_models(http)
    except CatalogError as exc:
        raise ActionError(str(exc), 502) from exc


@router.put("/settings", response_model=SettingsView)
async def update_settings(body: SettingsUpdate, service: Dep):
    values = {}
    for key in body.model_fields_set:
        value = getattr(body, key)
        if value is None or (key == "model" and not value.strip()):
            raise ActionError("Укажите непустое значение настройки", 422)
        values[key] = value.strip()
    service.repo.set_settings(values)
    return service.credentials()[1]


@router.get("/procurements", response_model=list[ProcurementSummary])
async def procurements(service: Dep):
    return service.repo.list_procurements()


@router.post("/procurements", status_code=201, response_model=Procurement)
async def create_procurement(
    service: Dep,
    file: Annotated[UploadFile | None, File()] = None,
    tz_text: Annotated[str | None, Form()] = None,
    message: Annotated[str | None, Form()] = None,
):
    messages = []
    filename = None
    if file is not None:
        filename = (file.filename or "ТЗ").replace("\\", "/").split("/")[-1]
        try:
            data = await file.read(MAX_FILE_BYTES + 1)
        finally:
            await file.close()
        if len(data) > MAX_FILE_BYTES:
            raise ActionError("Размер файла ТЗ превышает 20 МБ", 413)
        try:
            text = await asyncio.to_thread(extract_text, filename, data)
        except ValueError as exc:
            raise ActionError(str(exc), 400) from exc
        messages.append(
            FileMessage(
                id=new_id("m"),
                created_at=now(),
                role="user",
                data=FileData(filename=filename, size_bytes=len(data)),
            )
        )
    else:
        text = (tz_text or "").strip()
        if not text:
            raise ActionError("Загрузите файл или вставьте текст ТЗ", 400)
        if len(text.encode()) > MAX_FILE_BYTES:
            raise ActionError("Размер ТЗ превышает 20 МБ", 413)
        messages.append(TextMessage(id=new_id("m"), created_at=now(), role="user", text=text))
    if message and message.strip():
        messages.append(
            TextMessage(id=new_id("m"), created_at=now(), role="user", text=message.strip())
        )
    pid = service.repo.create_procurement(
        Path(filename).stem if filename else "Новая закупка", filename, text, messages
    )
    return service.repo.get_procurement(pid)


@router.get("/procurements/{pid}", response_model=Procurement)
async def procurement(pid: str, service: Dep):
    service.require(pid)
    return service.repo.get_procurement(pid)


@router.post("/procurements/{pid}/run", status_code=202)
async def run(pid: str, service: Dep):
    service.require(pid)
    return {"run_id": await service.start_run(pid)}


@router.post("/procurements/{pid}/messages", status_code=202, response_model=Message)
async def send_message(pid: str, body: MessageInput, service: Dep):
    service.require(pid)
    if body.viewing_version and service.repo.get_report(pid, body.viewing_version) is None:
        raise ActionError("Версия отчёта не найдена", 404)
    message = TextMessage(id=new_id("m"), created_at=now(), role="user", text=body.text.strip())
    await service.enqueue(pid, "chat", body.model_dump() | {"message_id": message.id}, message)
    return message


@router.post("/procurements/{pid}/questions/{qid}/answer", status_code=202)
async def answer(pid: str, qid: str, body: AnswerInput, service: Dep):
    state = service.require(pid)
    if state["parsed"] is None or qid not in {q.id for q in state["parsed"].questions}:
        raise ActionError("Вопрос не найден", 404)
    if not service.deterministic_answer(pid, qid, body.answer.strip()):
        service.require_key()
    await service.enqueue(pid, "answer", {"question_id": qid, "answer": body.answer.strip()})
    return {}


@router.get("/procurements/{pid}/reports", response_model=list[VersionInfo])
async def versions(pid: str, service: Dep):
    service.require(pid)
    return service.repo.list_versions(pid)


def get_report(service, pid, version):
    service.require(pid)
    if version != "latest":
        try:
            version = int(version)
        except ValueError as exc:
            raise ActionError("Версия отчёта не найдена", 404) from exc
    report = service.repo.get_report(pid, None if version == "latest" else version)
    if report is None:
        raise ActionError("Версия отчёта не найдена", 404)
    return report


@router.get("/procurements/{pid}/reports/{version}", response_model=Report)
async def report(pid: str, version: str, service: Dep):
    return get_report(service, pid, version)


@router.get("/procurements/{pid}/reports/{version}/export.docx")
async def export(pid: str, version: str, service: Dep):
    from app.report.docx_export import render_docx

    report = get_report(service, pid, version)
    data = await asyncio.to_thread(render_docx, report)
    filename = quote(f"НМЦК - {report.title[:120]} - версия {report.version}.docx", safe="")
    return Response(
        data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@router.get("/procurements/{pid}/edits", response_model=list[Edit])
async def edits(pid: str, service: Dep):
    service.require(pid)
    return service.repo.edits(pid)


@router.post("/procurements/{pid}/edits/cancel", status_code=202)
async def cancel(pid: str, body: CancelInput, service: Dep):
    from app.agent.chat import Turn

    service.require(pid)
    selected = {e.id: e for e in service.repo.edits(pid)}
    if set(body.edit_ids) - selected.keys():
        raise ActionError("Правка не найдена", 404)
    if any(selected[e].status != "active" for e in body.edit_ids):
        raise ActionError("Одна из правок уже отменена или вытеснена")
    if len(set(body.edit_ids)) != len(body.edit_ids):
        raise ActionError("Укажите разные действующие правки", 400)
    # Проверяем и необходимость сети до принятия задания; данные пока только в памяти.
    preview = Turn(service, pid, None, {}, origin="button")
    await preview.cancel(body.edit_ids)
    await service.enqueue(pid, "cancel", body.model_dump())
    return {}


async def event_stream(service, pid):
    async with service.bus.subscribe(pid) as queue:
        yield ": connected\n\n"
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15)
            except TimeoutError:
                yield ": ping\n\n"
                continue
            if event is None:
                return
            yield f"event: {event.type}\ndata: {json.dumps(event.data, ensure_ascii=False)}\n\n"


@router.get("/procurements/{pid}/events")
async def events(pid: str, service: Dep):
    service.require(pid)
    return StreamingResponse(
        event_stream(service, pid),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
