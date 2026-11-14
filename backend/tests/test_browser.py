"""Контракты вкладок, ownership, капчи и изоляции без сети и Chromium."""

import asyncio
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeout

from app.browser.manager import (
    BrowserManager,
    PageUnavailable,
    SourceSkipped,
    Tab,
    navigation_error,
    viewport_for,
)
from app.config import Settings, SourceConfig
from app.main import create_app
from app.sources.base import source_error
from app.sources.fetch import html_text


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

    def locator(self, selector):
        class Widgets:
            async def count(self):
                return 0

        return Widgets()

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
    # Возврат управления ещё не подтверждает, что проверка пройдена.
    assert events == ["waiting"] and not tab.blocked
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


@pytest.mark.parametrize("status", [403, 429, 503])
async def test_http_block_without_captcha_does_not_wait_for_user(monkeypatch, status):
    manager = BrowserManager()
    page = Page("<title>Доступ ограничен</title><body>Повторите позже</body>")
    tab = add(manager, page=page)

    async def fake_tab(*args):
        return tab

    async def goto(*args, **kwargs):
        return SimpleNamespace(status=status)

    monkeypatch.setattr(manager, "_tab", fake_tab)
    page.goto = goto
    cfg = SourceConfig(id="web", name="Магазин", level=2, type="web")
    with pytest.raises(httpx.HTTPStatusError) as exc:
        await manager.fetch("p1", cfg, 1, page.url, 1000)
    assert source_error(exc.value)[0] == "unavailable"
    assert not tab.blocked and not tab.skipped


async def test_premature_resume_keeps_captcha_available_until_verified(monkeypatch):
    events = []

    async def callback(tab, reason, status):
        events.append(status)

    manager = BrowserManager(callback, wait_seconds=1)
    page = Page("<title>Captcha</title><body>Подтвердите, что вы не робот</body>")
    tab = add(manager, page=page)

    async def fake_tab(*args):
        return tab

    monkeypatch.setattr(manager, "_tab", fake_tab)
    cfg = SourceConfig(id="web", name="Магазин", level=2, type="web")
    task = asyncio.create_task(manager.fetch("p1", cfg, 1, page.url, 1000))
    while not tab.blocked:
        await asyncio.sleep(0)
    await manager.command("p1", "alice", dict(type="resume", tab_id="t1"))
    while len(events) < 2:
        await asyncio.sleep(0)
    assert events == ["waiting", "waiting"] and not task.done() and not tab.skipped
    page.html = "<title>Товар</title><body>Цена 100 рублей</body>"
    await manager.command("p1", "alice", dict(type="resume", tab_id="t1"))
    assert (await task).text == "Цена 100 рублей"
    assert events[-1] == "resolved" and len(page.navigations) == 1


def test_background_captcha_tokens_do_not_block_product_extraction():
    title, text = html_text(
        "<title>Бумага</title><body>Цена 100 рублей"
        '<input type="hidden" name="smartcaptcha-token">'
        '<iframe src="https://captcha.example.org/invisible"></iframe></body>'
    )
    assert title == "Бумага" and "100" in text


async def test_yandex_visible_challenge_detected_but_hidden_widget_ignored():
    class Widgets:
        visible = False

        async def count(self):
            return 1

        def nth(self, index):
            return self

        async def is_visible(self):
            return self.visible

    widgets = Widgets()
    page = SimpleNamespace(locator=lambda selector: widgets)
    manager = BrowserManager()
    assert not await manager._captcha(page, "Магазин")
    widgets.visible = True
    assert await manager._captcha(page, "Ой!")


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


# --- Ошибки Chromium, сбой вкладки, screencast и журнал (без сети и Chromium).

CFG = SourceConfig(id="web", name="Магазин", level=2, type="web")


class EventPage(Page):
    """Страница с подписками на события, как у Playwright."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.handlers = {}
        self.closed = False
        self.main_frame = object()

    def on(self, name, handler):
        self.handlers.setdefault(name, []).append(handler)

    def emit(self, name, *args):
        for handler in self.handlers.get(name, []):
            handler(*args)

    def is_closed(self):
        return self.closed

    async def close(self):
        self.closed = True
        self.emit("close", self)


def fetch_tab(manager, monkeypatch, page):
    tab = add(manager, page=page)

    async def fake_tab(*args):
        return tab

    monkeypatch.setattr(manager, "_tab", fake_tab)
    return tab


@pytest.mark.parametrize(
    "exc, reason",
    [
        (PlaywrightTimeout("Page.goto: Timeout 30000ms exceeded."), "Сайт не ответил за 30 секунд"),
        (PlaywrightError("Page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.ru/"), "не найден"),
        (PlaywrightError("Page.goto: net::ERR_CERT_DATE_INVALID at https://x.ru/"), "сертификат"),
        (PlaywrightError("Page.goto: net::ERR_CONNECTION_CLOSED at https://x.ru/"), "ошибка сети"),
        (PlaywrightError("Page.goto: Page crashed"), "аварийно"),
        (PlaywrightError("Page.goto: Download is starting"), "файл"),
    ],
)
def test_playwright_navigation_errors_have_clear_reasons(exc, reason):
    mapped = navigation_error(exc)
    assert isinstance(mapped, PageUnavailable) and reason in str(mapped)
    assert source_error(mapped) == ("unavailable", str(mapped))
    assert navigation_error(TimeoutError()) is None


async def test_navigation_timeout_skips_page_and_hides_chrome_error_url(monkeypatch):
    manager = BrowserManager()
    page = Page()
    tab = fetch_tab(manager, monkeypatch, page)

    async def goto(url, **kwargs):
        if url == "about:blank":
            page.navigations.append(url)
            return None
        page.url = "chrome-error://chromewebdata/"
        raise PlaywrightTimeout("Page.goto: Timeout 30000ms exceeded.")

    page.goto = goto
    target = "https://shop.example.org/item"
    with pytest.raises(PageUnavailable, match="не ответил за 30 секунд") as exc:
        await manager.fetch("p1", CFG, 1, target, 1000)
    assert source_error(exc.value)[0] == "unavailable"
    public = tab.public()
    assert public["url"] == target and public["domain"] == "shop.example.org"
    assert public["state"] == "error" and "30 секунд" in public["error"]
    # Загрузка остановлена, вкладка не висит на служебной странице Chromium.
    assert page.navigations == ["about:blank"]
    events = manager.journal("p1")
    assert events[-1]["kind"] == "skipped" and "не ответил" in events[-1]["text"]
    assert "—" not in events[-1]["text"] and "–" not in events[-1]["text"]


async def test_chrome_error_page_after_navigation_is_unavailable(monkeypatch):
    manager = BrowserManager()
    page = Page()
    fetch_tab(manager, monkeypatch, page)

    async def goto(url, **kwargs):
        page.url = "chrome-error://chromewebdata/" if url != "about:blank" else url
        return None

    page.goto = goto
    with pytest.raises(PageUnavailable, match="ошибка сети"):
        await manager.fetch("p1", CFG, 1, "https://shop.example.org/item", 1000)


async def test_blocked_redirect_fails_fast_instead_of_goto_timeout(monkeypatch):
    manager = BrowserManager()
    page = Page()
    tab = fetch_tab(manager, monkeypatch, page)
    hang = asyncio.Event()

    async def goto(url, **kwargs):
        if url == "about:blank":
            return None
        asyncio.get_running_loop().call_soon(tab.nav_blocked.set)
        await hang.wait()

    page.goto = goto
    with pytest.raises(PageUnavailable, match="закрытый адрес"):
        await asyncio.wait_for(manager.fetch("p1", CFG, 1, "https://x.example.org/", 1000), 2)


async def test_status_403_bot_check_text_waits_for_user(monkeypatch):
    manager = BrowserManager(wait_seconds=0.05)
    page = Page("<title>Комус</title><body>Подтвердите, что вы не робот</body>")
    tab = fetch_tab(manager, monkeypatch, page)

    async def goto(*args, **kwargs):
        return SimpleNamespace(status=403)

    async def evaluate(*args):
        return "Запросы похожи на автоматические\nПодтвердите, что вы не робот"

    page.goto, page.evaluate = goto, evaluate
    with pytest.raises(SourceSkipped):
        await manager.fetch("p1", CFG, 1, page.url, 1000)
    assert tab.public()["state"] == "skipped"
    kinds = [e["kind"] for e in manager.journal("p1")]
    assert "waiting" in kinds and kinds[-1] == "skipped"


async def test_waiting_tab_reports_deadline_and_needs():
    manager = BrowserManager(wait_seconds=5)
    tab = add(manager)
    task = asyncio.create_task(manager._blocked(tab, "captcha"))
    await asyncio.sleep(0)
    public = tab.public()
    assert public["state"] == "needs_user" and public["needs"] == "captcha"
    assert public["wait_seconds"] == 5 and public["deadline"].endswith("Z")
    tab.resume.set()
    await task
    assert tab.public()["deadline"] is None


class Context:
    def __init__(self):
        self.pages = []

    async def new_page(self):
        page = EventPage()
        page.context = self
        self.pages.append(page)
        return page


async def test_crashed_tab_is_recreated_under_same_id():
    manager = BrowserManager()
    context = Context()
    manager.contexts["p1"] = context
    old = await context.new_page()
    tab = manager._register("p1", "web", "Магазин", 1, old)
    old.emit("crash", old)
    while tab.page is old or not old.closed:
        await asyncio.sleep(0)
    await asyncio.gather(*manager.releases)
    assert manager.tabs[tab.id] is tab and tab.page is context.pages[-1]
    assert tab.public()["state"] == "error" and "аварийно" in tab.public()["error"]
    assert manager.journal("p1")[-1]["kind"] == "error"
    # Закрытие старой страницы вкладку не убрало; закрытие новой убирает.
    tab.page.emit("close", tab.page)
    assert tab.id not in manager.tabs


async def test_crashed_popup_is_closed():
    manager = BrowserManager()
    manager.contexts["p1"] = Context()
    page = EventPage()
    tab = manager._register("p1", "web", "Магазин", 1, page)
    tab.popup = True
    page.emit("crash", page)
    await asyncio.gather(*manager.releases)
    assert page.closed and tab.id not in manager.tabs


class CDP:
    def __init__(self):
        self.sent, self.handlers, self.detached = [], {}, False

    def on(self, name, handler):
        self.handlers[name] = handler

    async def send(self, method, params=None):
        self.sent.append((method, params))

    async def detach(self):
        self.detached = True


async def test_screencast_frames_are_acked_and_quality_follows_control():
    manager = BrowserManager()
    page = Page()
    sessions = []

    async def new_cdp_session(target):
        assert target is page
        sessions.append(CDP())
        return sessions[-1]

    page.context = SimpleNamespace(new_cdp_session=new_cdp_session)
    tab = add(manager, page=page)
    assert not await manager.ensure_cast(tab)  # Никто не смотрит: screencast не нужен.
    event = manager.watch(tab, "alice")
    assert await manager.ensure_cast(tab)
    cdp = sessions[0]
    method, params = cdp.sent[0]
    assert method == "Page.startScreencast"
    assert params == dict(format="jpeg", quality=60, maxWidth=1280, maxHeight=800, everyNthFrame=2)
    cdp.handlers["Page.screencastFrame"](
        dict(
            data="ZnJhbWU=",
            sessionId=7,
            metadata=dict(deviceWidth=1280, deviceHeight=800, scrollOffsetY=240, timestamp=1.5),
        )
    )
    await asyncio.gather(*manager.releases)
    assert ("Page.screencastFrameAck", {"sessionId": 7}) in cdp.sent
    assert event.is_set() and tab.frame_seq == 1
    assert tab.frame["data"] == "ZnJhbWU=" and tab.frame["scroll_y"] == 240
    assert tab.frame["source"] == "screencast" and tab.frame["format"] == "jpeg"
    # Ручное управление: перезапуск с повышенным качеством и каждым кадром.
    tab.owner = "alice"
    assert await manager.ensure_cast(tab)
    assert ("Page.stopScreencast", None) in cdp.sent and cdp.detached
    assert sessions[1].sent[0][1]["quality"] == 85
    assert sessions[1].sent[0][1]["everyNthFrame"] == 1
    # Кадр старой сессии после перезапуска подтверждается, но наблюдателю не уходит.
    cdp.handlers["Page.screencastFrame"](dict(data="b2xk", sessionId=8, metadata={}))
    await asyncio.gather(*manager.releases)
    assert ("Page.screencastFrameAck", {"sessionId": 8}) in cdp.sent
    assert tab.frame["data"] == "ZnJhbWU="
    manager.unwatch(tab, "alice")
    await asyncio.gather(*manager.releases)
    assert sessions[1].detached and tab.cast is None


async def test_viewport_follows_panel_within_desktop_limits():
    assert viewport_for(600, 400) == (1024, 683)
    assert viewport_for(2000, 1000) == (1440, 720)
    assert viewport_for(1200, 2000) == (1200, 1100)
    with pytest.raises(ValueError):
        viewport_for(0, 100)
    manager = BrowserManager()
    page = Page()
    sizes = []

    async def set_viewport_size(size):
        sizes.append(size)

    page.set_viewport_size = set_viewport_size
    tab = add(manager, page=page)
    assert await manager.set_viewport(tab, "alice", 1400, 900) == (1400, 900)
    assert sizes == [{"width": 1400, "height": 900}]
    tab.owner = "bob"
    assert await manager.set_viewport(tab, "alice", 1100, 700) == (1400, 900)
    # Координаты мыши проверяются по текущему viewport.
    await manager.command(
        "p1", "bob", dict(type="mouse", tab_id=tab.id, x=1390, y=880, event="down", click_count=2)
    )
    assert page.mouse.calls[-1] == ("down", (), {"button": "left", "click_count": 2})


async def test_page_result_adds_found_price_to_journal_and_finishes_tab():
    manager = BrowserManager()
    tab = add(manager)
    tab.target_url, tab.status = "https://www.komus.ru/p/1", "reading"
    manager.page_result(
        "p1",
        dict(
            position_index=1,
            source_id="web",
            source_name="Магазин",
            url="https://www.komus.ru/p/1",
            offers=[dict(price="1389.5", amount="1", unit="пачка", title="Бумага")],
        ),
    )
    event = manager.journal("p1")[-1]
    assert event["kind"] == "found" and event["text"] == "komus.ru: цена 1 389,50 ₽ за 1 пачка"
    assert event["price"] == "1389.5" and event["tab_id"] == tab.id
    assert tab.public()["state"] == "done"
    manager.page_result("p1", dict(source_id="eis", url="https://zakupki.gov.ru/x", offers=[]))
    assert manager.journal("p1")[-1]["kind"] == "skipped"
    assert [e["id"] for e in manager.journal("p1", event["id"])] == [event["id"] + 1]


def test_websocket_sends_journal_and_accepts_viewport(tmp_path):
    app = create_app(Settings(_env_file=None, data_dir=tmp_path))
    with TestClient(app) as client:
        manager = app.state.service.browser
        pid = client.post("/api/procurements", data={"tz_text": "ТЗ"}).json()["id"]
        page = Page()
        sizes = []

        async def set_viewport_size(size):
            sizes.append(size)

        page.set_viewport_size = set_viewport_size
        add(manager, "t1", pid, page=page)
        manager.log(pid, "opened", "Открыта страница example.org")
        with client.websocket_connect(f"/api/browser?procurement_id={pid}") as ws:
            seen = {}
            ws.send_json(dict(type="viewport", width=700, height=500))
            for _ in range(30):
                data = ws.receive_json()
                if data["type"] == "frame" and data["width"] != 1024:
                    continue
                seen.setdefault(data["type"], data)
                if "journal" in seen and "frame" in seen and sizes:
                    break
            assert seen["journal"]["full"] is True
            assert seen["journal"]["events"][0]["text"] == "Открыта страница example.org"
            assert seen["tabs"]["tabs"][0]["state"] == "loading"
            assert seen["frame"]["width"] == 1024 and seen["frame"]["format"] == "jpeg"
            assert sizes == [{"width": 1024, "height": 731}]
