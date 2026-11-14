"""REST/SSE общих и локальных настроек."""

import asyncio
import json
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.api.models import MessageInput
from app.api.routes import Dep
from app.p1.configuration import configuration_for

router = APIRouter(prefix="/api")


@router.get("/config")
async def config(service: Dep):
    return configuration_for(service).config()


@router.get("/config/changes")
async def changes(service: Dep):
    return configuration_for(service).changes()


@router.get("/config/messages")
async def messages(service: Dep):
    return configuration_for(service).messages()


@router.post("/config/messages", status_code=202)
async def send(body: MessageInput, service: Dep):
    return await configuration_for(service).enqueue(body.text)


@router.post("/config/proposals/{proposal_id}/apply", status_code=202)
async def apply(proposal_id: str, service: Dep):
    await configuration_for(service).decide(proposal_id, True)
    return {}


@router.post("/config/proposals/{proposal_id}/reject")
async def reject(proposal_id: str, service: Dep):
    await configuration_for(service).decide(proposal_id, False)
    return {}


@router.post("/config/changes/{change_id}/cancel", status_code=202)
async def cancel(change_id: str, service: Dep):
    await configuration_for(service).cancel_change(change_id)
    return {}


@router.get("/procurements/{pid}/settings")
async def local(pid: str, service: Dep):
    return configuration_for(service).local_settings(pid)


@router.post("/procurements/{pid}/settings/rebase", status_code=202)
async def rebase(pid: str, service: Dep):
    await configuration_for(service).rebase(pid)
    return {}


@router.get("/config/events")
async def events(service: Dep):
    config = configuration_for(service)

    async def stream():
        async with config.bus.subscribe("config") as queue:
            yield (
                "event: agent\ndata: "
                + json.dumps({"busy": bool(config.worker and not config.worker.done())})
                + "\n\n"
            )
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield ": ping\n\n"
                    continue
                if event is None:
                    return
                yield f"event: {event.type}\ndata: {json.dumps(event.data, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


async def key_http():
    async with httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5)) as client:
        yield client


@router.post("/settings/check")
async def check(service: Dep, http: Annotated[httpx.AsyncClient, Depends(key_http)]):
    key, view = service.credentials()
    if not view.has_api_key:
        return {"ok": False, "detail": "Не задан ключ OpenRouter. Укажите его в настройках."}
    try:
        response = await http.get(
            "https://openrouter.ai/api/v1/auth/key", headers={"Authorization": f"Bearer {key}"}
        )
        if response.status_code in (401, 403):
            return {"ok": False, "detail": "Ключ OpenRouter недействителен"}
        if response.status_code != 200 or not isinstance(response.json().get("data"), dict):
            raise ValueError
    except (httpx.RequestError, ValueError, TypeError, AttributeError):
        return {"ok": False, "detail": "Не удалось проверить ключ. Повторите позже."}
    return {"ok": True, "detail": None}
