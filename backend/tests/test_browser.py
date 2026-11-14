"""Контракты вкладок, ownership, капчи и изоляции без сети и Chromium."""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.browser.manager import BrowserManager, SourceSkipped, Tab
from app.config import Settings, SourceConfig
from app.main import create_app


class Input:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        async def call(*args, **kwargs):
            self.calls.append((name, args, kwargs))

        return call


class Page:
    url = "https://example.org/product"

    def __init__(self, html="<title>Товар</title><body>Цена 100 рублей</body>"):
        self.html = html
        self.mouse, self.keyboard = Input(), Input()
        self.navigations = []

    async def title(self):
        return "Карточка товара"

    async def content(self):
        return self.html

    async def goto(self, url, **kwargs):
        self.url = url
        self.navigations.append(url)
        return SimpleNamespace(status=200)

    async def wait_for_load_state(self, *args, **kwargs):
        pass

    async def screenshot(self, **kwargs):
        return b"jpeg-bytes"


def add(manager, tid="t1", pid="p1", source="web", page=None):
    tab = Tab(tid, pid, source, "Магазин", page or Page(), 1)
    manager.tabs[tid] = tab
    return tab


async def test_tabs_are_isolated_and_control_has_single_owner():
    manager = BrowserManager()
    tab = add(manager)
    add(manager, "t2", "p2")
    assert [t.id for t in manager.tabs_for("p1")] == ["t1"]
    with pytest.raises(ValueError):
        manager.get("p1", "t2")
    with pytest.raises(ValueError, match="Сначала"):
        await manager.command("p1", "alice", dict(type="text", tab_id="t1", text="test"))
    await manager.command("p1", "alice", dict(type="control", tab_id="t1", by="user"))
    with pytest.raises(ValueError, match="другой"):
        await manager.command("p1", "bob", dict(type="control", tab_id="t1", by="user"))
    await manager.command("p1", "alice", dict(type="text", tab_id="t1", text="captcha"))
    assert tab.page.keyboard.calls[-1][0] == "insert_text"
    manager.release("alice")
    assert tab.owner is None and tab.resume.is_set()


async def test_inputs_reject_out_of_frame_and_oversized_values():
    manager = BrowserManager()
    add(manager).owner = "alice"
    for data in (
        dict(type="mouse", x=-1, y=5, event="down"),
        dict(type="wheel", dx=0, dy=10001),
        dict(type="text", text="x" * 10001),
    ):
        with pytest.raises(ValueError):
            await manager.command("p1", "alice", dict(tab_id="t1", **data))


async def test_captcha_wait_resumes_and_skip_unblocks_every_tab():
    events = []

    async def callback(tab, reason, status):
        events.append(status)

    manager = BrowserManager(callback, wait_seconds=0.05)
    tab = add(manager)
    task = asyncio.create_task(manager._blocked(tab, "captcha"))
    await asyncio.sleep(0)
    assert tab.blocked and tab.status == "waiting"
    await manager.command("p1", "alice", dict(type="resume", tab_id="t1"))
    await task
    assert events == ["waiting", "resolved"] and not tab.blocked
    task = asyncio.create_task(manager._blocked(tab, "captcha"))
    await asyncio.sleep(0)
    await manager.skip("p1", "web")
    with pytest.raises(SourceSkipped):
        await task
    assert events[-1] == "skipped"


async def test_captcha_timeout_is_explicit_skip():
    manager = BrowserManager(wait_seconds=0.001)
    with pytest.raises(SourceSkipped):
        await manager._blocked(add(manager), "captcha")


async def test_rendered_page_is_extracted_after_captcha_and_has_source_url(monkeypatch):
    manager = BrowserManager(wait_seconds=1)
    page = Page('<title>captcha</title><input name="captcha">')
    tab = add(manager, page=page)

    async def fake_tab(*args):
        return tab

    monkeypatch.setattr(manager, "_tab", fake_tab)
    cfg = SourceConfig(id="web", name="Магазин", level=2, type="web")
    task = asyncio.create_task(manager.fetch("p1", cfg, 1, page.url, 1000))
    while not tab.blocked:
        await asyncio.sleep(0)
    page.html = "<title>Товар</title><body>Цена 100 рублей</body>"
    tab.resume.set()
    result = await task
    assert result.text == "Цена 100 рублей" and result.url == page.url
    assert tab.status == "reading"
    frame = await manager.frame(tab)
    assert frame["tab_id"] == tab.id and frame["data"] == "anBlZy1ieXRlcw=="


async def test_fetch_rejects_private_url_before_opening_browser():
    manager = BrowserManager()
    cfg = SourceConfig(id="web", name="Магазин", level=2, type="web")
    with pytest.raises(ValueError):
        await manager.fetch("p1", cfg, 1, "http://127.0.0.1/admin", 1000)
    assert not manager.tabs and manager._browser is None


def test_websocket_lists_all_tabs_switches_frames_and_releases_control(tmp_path):
    app = create_app(Settings(_env_file=None, data_dir=tmp_path))
    with TestClient(app) as client:
        manager = app.state.service.browser
        pid = client.post("/api/procurements", data={"tz_text": "ТЗ"}).json()["id"]
        add(manager, "t1", pid)
        second = add(manager, "t2", pid)
        add(manager, "secret", "other")
        with client.websocket_connect(f"/api/browser?procurement_id={pid}") as ws:
            tabs = ws.receive_json()
            assert {t["id"] for t in tabs["tabs"]} == {"t1", "t2"}
            ws.send_json(dict(type="select", tab_id="t2"))
            ws.send_json(dict(type="control", tab_id="t2", by="user"))
            for _ in range(12):
                data = ws.receive_json()
                if data["type"] == "frame" and data["tab_id"] == "t2":
                    break
            else:
                pytest.fail("Не пришёл кадр выбранной вкладки")
            assert second.owner is not None
        # TestClient disconnect waits for websocket cleanup.
        assert second.owner is None


def test_websocket_rejects_other_origin(tmp_path):
    from starlette.websockets import WebSocketDisconnect

    app = create_app(Settings(_env_file=None, data_dir=tmp_path))
    with TestClient(app) as client, pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/browser", headers={"origin": "https://evil.example"}):
            pass


async def test_disconnect_releases_pressed_modifiers_and_mouse_buttons():
    manager = BrowserManager()
    tab = add(manager)
    await manager.command("p1", "alice", dict(type="control", tab_id="t1", by="user"))
    await manager.command("p1", "alice", dict(type="key", tab_id="t1", event="down", key="Shift"))
    await manager.command(
        "p1", "alice", dict(type="mouse", tab_id="t1", event="down", x=10, y=10, button="left")
    )
    manager.release("alice")
    await asyncio.gather(*manager.releases)
    assert not tab.pressed and not tab.buttons and tab.owner is None
    assert tab.page.keyboard.calls[-1][0] == "up"
    assert tab.page.mouse.calls[-1][0] == "up"


async def test_new_agent_page_event_does_not_close_its_own_page():
    manager = BrowserManager()
    page = Page()
    closed = []

    async def opener():
        return None

    async def close():
        closed.append(True)

    page.opener, page.close = opener, close
    await manager._popup("p1", page)
    assert not closed
