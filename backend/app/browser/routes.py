"""Подписка на реальные вкладки; кадры передаются только выбранному наблюдателю."""

import asyncio
import json
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from app.service import ActionError

router = APIRouter(prefix="/api")


@router.websocket("/browser")
async def browser(websocket: WebSocket):
    origin = websocket.headers.get("origin")
    if origin and urlsplit(origin).netloc != websocket.url.netloc:
        await websocket.close(code=1008)
        return
    service = websocket.app.state.service
    pid = websocket.query_params.get("procurement_id", "")
    try:
        service.require(pid)
    except ActionError:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    manager, owner = service.browser, uuid4().hex
    selected = None
    send_lock = asyncio.Lock()

    async def send(data):
        async with send_lock:
            await websocket.send_json(data)

    async def watch():
        nonlocal selected
        previous = None
        while True:
            tabs = manager.tabs_for(pid)
            if selected not in {t.id for t in tabs}:
                selected = tabs[0].id if tabs else None
            snapshot = dict(type="tabs", tabs=[t.public() for t in tabs], selected_tab_id=selected)
            signature = json.dumps(snapshot, ensure_ascii=False)
            if signature != previous:
                await send(snapshot)
                previous = signature
            if selected:
                tab = manager.tabs.get(selected)
                if tab:
                    await send(
                        dict(
                            type="control",
                            tab_id=selected,
                            by="user" if tab.owner == owner else "agent",
                        )
                    )
                    try:
                        frame = await manager.frame(tab)
                        if selected == tab.id:
                            await send(frame)
                    except Exception:
                        # Навигация и закрытие вкладки временно прерывают снимок.
                        pass
            await asyncio.sleep(0.75)

    async def receive():
        nonlocal selected
        while True:
            try:
                raw = await websocket.receive_text()
                if len(raw) > 20000:
                    raise ValueError("Действие слишком большое")
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError("Неверный формат действия")
                if data.get("type") == "select":
                    selected = manager.get(pid, data.get("tab_id")).id
                else:
                    await manager.command(pid, owner, data)
            except (ValueError, TypeError):
                await send(dict(type="error", detail="Не удалось выполнить действие браузера"))
            except WebSocketDisconnect:
                return
            except Exception:
                await send(dict(type="error", detail="Вкладка недоступна. Попробуйте снова."))

    tasks = [asyncio.create_task(watch()), asyncio.create_task(receive())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            try:
                task.result()
            except (WebSocketDisconnect, RuntimeError):
                pass
    except asyncio.CancelledError:
        pass
    finally:
        manager.release(owner)
        for task in tasks:
            task.cancel()
        try:
            await asyncio.gather(*tasks, return_exceptions=True)
        except asyncio.CancelledError:
            pass


@router.post("/procurements/{pid}/sources/{source_id}/skip", status_code=202)
async def skip_source(pid: str, source_id: str, request: Request):
    service = request.app.state.service
    state = service.require(pid)
    known = {s.id for s in state["sources"]} | {t.source_id for t in service.browser.tabs_for(pid)}
    if source_id not in known:
        raise ActionError("Источник не найден", 404)
    await service.browser.skip(pid, source_id)
    return {}
