"""Подписка на реальные вкладки; кадры screencast только выбранной наблюдателем вкладки."""

import asyncio
import json
import time
from contextlib import suppress
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from app.browser.manager import viewport_for
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
    viewport = None
    send_lock = asyncio.Lock()
    changed = asyncio.Event()

    async def send(data):
        async with send_lock:
            await websocket.send_json(data)

    async def state():
        """Список вкладок, владелец управления и журнал: только при изменениях."""
        nonlocal selected
        previous = control = None
        journal_id = 0
        first = True
        while True:
            tabs = manager.tabs_for(pid)
            if selected not in {t.id for t in tabs}:
                selected = tabs[0].id if tabs else None
                changed.set()
            snapshot = dict(type="tabs", tabs=[t.public() for t in tabs], selected_tab_id=selected)
            signature = json.dumps(snapshot, ensure_ascii=False)
            if signature != previous:
                await send(snapshot)
                previous = signature
            tab = manager.tabs.get(selected) if selected else None
            current = (selected, "user" if tab and tab.owner == owner else "agent")
            if tab and current != control:
                await send(dict(type="control", tab_id=selected, by=current[1]))
                control = current
            events = manager.journal(pid, journal_id)
            if first or events:
                await send(dict(type="journal", full=first, events=events))
                journal_id = events[-1]["id"] if events else journal_id
                first = False
            await asyncio.sleep(0.25)

    async def frames():
        """Кадры выбранной вкладки: последний кадр screencast, без очереди."""
        watched = event = None
        sent = -1
        since = time.monotonic()
        while True:
            tab = manager.tabs.get(selected) if selected else None
            if (tab.id if tab else None) != (watched.id if watched else None) or (
                tab and owner not in tab.watchers
            ):
                if watched:
                    manager.unwatch(watched, owner)
                watched, event, sent, since = tab, None, -1, time.monotonic()
                if tab:
                    event = manager.watch(tab, owner)
                    if viewport:
                        await manager.set_viewport(tab, owner, *viewport)
            if tab is None:
                changed.clear()
                with suppress(TimeoutError):
                    await asyncio.wait_for(changed.wait(), 0.5)
                continue
            casting = await manager.ensure_cast(tab)
            with suppress(TimeoutError):
                await asyncio.wait_for(event.wait(), 0.5)
            event.clear()
            if tab.frame and tab.frame_seq != sent and selected == tab.id:
                sent = tab.frame_seq
                since = time.monotonic()
                await send(tab.frame)
            elif time.monotonic() - since > 1 and (not casting or sent < 0):
                # Screencast ещё молчит (статичная страница) или недоступен: одиночный снимок.
                since = time.monotonic()
                with suppress(Exception):
                    await manager.frame(tab)

    async def receive():
        nonlocal selected, viewport
        moved = 0.0
        cursor = None
        while True:
            try:
                raw = await websocket.receive_text()
                if len(raw) > 20000:
                    raise ValueError("Действие слишком большое")
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError("Неверный формат действия")
                kind = data.get("type")
                if kind == "select":
                    selected = manager.get(pid, data.get("tab_id")).id
                    changed.set()
                elif kind == "viewport":
                    viewport = viewport_for(data.get("width"), data.get("height"))
                    tab = manager.tabs.get(selected) if selected else None
                    if tab:
                        await manager.set_viewport(tab, owner, *viewport)
                else:
                    tab = await manager.command(pid, owner, data)
                    now = time.monotonic()
                    if kind == "mouse" and data.get("event") == "move" and now - moved > 0.15:
                        moved = now
                        value = await manager.cursor(tab, data["x"], data["y"])
                        if value != cursor:
                            cursor = value
                            await send(dict(type="cursor", tab_id=tab.id, cursor=value))
            except (ValueError, TypeError):
                await send(dict(type="error", detail="Не удалось выполнить действие браузера"))
            except WebSocketDisconnect:
                return
            except Exception:
                await send(dict(type="error", detail="Вкладка недоступна. Попробуйте снова."))

    tasks = [asyncio.create_task(state()), asyncio.create_task(frames())]
    tasks.append(asyncio.create_task(receive()))
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
