"""Один Chromium, изолированные контексты закупок, независимые наблюдатели."""

import asyncio
import base64
import ipaddress
import socket
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from app.sources.base import CandidatePage
from app.sources.fetch import MAX_BODY, NeedsLogin, captcha_title, html_text, public_url

WIDTH, HEIGHT = 1280, 800


class SourceSkipped(ValueError):
    pass


@dataclass
class Tab:
    id: str
    procurement_id: str
    source_id: str
    name: str
    page: object
    position_index: int
    status: str = "loading"
    action: str = "Открываю страницу"
    blocked: bool = False
    owner: str | None = None
    skipped: bool = False
    resume: asyncio.Event = field(default_factory=asyncio.Event)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    title: str = ""
    pressed: set[str] = field(default_factory=set)
    buttons: set[str] = field(default_factory=set)

    def public(self):
        return dict(
            id=self.id,
            procurement_id=self.procurement_id,
            source_id=self.source_id,
            url=self.page.url,
            title=self.title,
            status=self.status,
            action=self.action,
            blocked=self.blocked,
        )


class BrowserManager:
    def __init__(self, on_blocked=None, *, wait_seconds=300):
        self.on_blocked = on_blocked
        self.wait_seconds = wait_seconds
        self.tabs = {}
        self.contexts = {}
        self.keys = {}
        self.scopes = {}
        self.skipped = set()
        self._lock = asyncio.Lock()
        self._playwright = self._browser = None
        self._dns = {}
        self.releases = set()

    async def _guard(self, route):
        try:
            url = public_url(route.request.url)
            host = urlsplit(url).hostname
            cached = self._dns.get(host)
            if cached is None or cached[0] < time.monotonic():
                addresses = await asyncio.get_running_loop().getaddrinfo(
                    host, None, type=socket.SOCK_STREAM
                )
                if not addresses or any(
                    not ipaddress.ip_address(item[4][0]).is_global for item in addresses
                ):
                    raise ValueError("Локальные сетевые адреса не разрешены")
                self._dns[host] = (time.monotonic() + 30, True)
            await route.continue_()
        except (ValueError, OSError):
            await route.abort()

    async def _context(self, pid):
        async with self._lock:
            if self._browser is None:
                from playwright.async_api import async_playwright

                self._playwright = await async_playwright().start()
                try:
                    self._browser = await self._playwright.chromium.launch(
                        headless=True, args=["--disable-dev-shm-usage"]
                    )
                except Exception:
                    await self._playwright.stop()
                    self._playwright = None
                    raise ValueError(
                        "Chromium не установлен. Выполните make browser-setup "
                        "или пересоберите Docker."
                    ) from None
            if pid not in self.contexts:
                context = await self._browser.new_context(
                    viewport={"width": WIDTH, "height": HEIGHT},
                    accept_downloads=False,
                    locale="ru-RU",
                    timezone_id="Europe/Moscow",
                    service_workers="block",
                )
                context.set_default_timeout(10000)
                await context.route("**/*", self._guard)
                self.contexts[pid] = context
                context.on("page", lambda page: asyncio.create_task(self._popup(pid, page)))
            return self.contexts[pid]

    async def _popup(self, pid, page):
        # new_page also triggers this event; its creator registers it first.
        await asyncio.sleep(0)
        if any(tab.page is page for tab in self.tabs.values()):
            return
        opener = await page.opener()
        parent = next((t for t in self.tabs.values() if t.page is opener), None)
        if parent is None:
            return
        if len(self.tabs_for(pid)) >= 24:
            await page.close()
            return
        self._register(pid, parent.source_id, parent.name, parent.position_index, page)

    def _register(self, pid, source_id, name, index, page):
        tab = Tab(uuid4().hex, pid, source_id, name, page, index)
        self.tabs[tab.id] = tab
        page.on("close", lambda: self.tabs.pop(tab.id, None))
        page.on("dialog", lambda dialog: asyncio.create_task(dialog.dismiss()))
        return tab

    @asynccontextmanager
    async def scope(self, pid):
        self.scopes[pid] = self.scopes.get(pid, 0) + 1
        try:
            yield
        finally:
            self.scopes[pid] -= 1
            if self.scopes[pid] == 0:
                self.scopes.pop(pid)
                context = self.contexts.pop(pid, None)
                if context:
                    await context.close()
                self.keys = {k: v for k, v in self.keys.items() if k[0] != pid}
                self.skipped = {k for k in self.skipped if k[0] != pid}

    def tabs_for(self, pid):
        return [t for t in self.tabs.values() if t.procurement_id == pid]

    def get(self, pid, tab_id):
        tab = self.tabs.get(tab_id)
        if tab is None or tab.procurement_id != pid:
            raise ValueError("Вкладка уже закрыта или недоступна")
        return tab

    async def _tab(self, pid, cfg, index):
        key = (pid, cfg.id, index)
        tab = self.tabs.get(self.keys.get(key))
        if tab is not None and not tab.page.is_closed():
            return tab
        context = await self._context(pid)
        page = await context.new_page()
        tab = self._register(pid, cfg.id, cfg.name, index, page)
        self.keys[key] = tab.id
        return tab

    async def _blocked(self, tab, reason, *, deadline=None):
        tab.blocked, tab.status = True, "waiting"
        tab.action = "Жду проверки капчи или входа"
        tab.resume.clear()
        if self.on_blocked:
            await self.on_blocked(tab, reason, "waiting")
        try:
            remaining = self.wait_seconds if deadline is None else deadline - time.monotonic()
            await asyncio.wait_for(tab.resume.wait(), max(0, remaining))
        except TimeoutError:
            tab.skipped = True
        finally:
            tab.blocked = False
            tab.owner = None
        if tab.skipped and self.on_blocked:
            await self.on_blocked(tab, reason, "skipped")
        if tab.skipped:
            raise SourceSkipped("Источник пропущен: проверка не завершена")

    async def _captcha(self, page, title):
        if captcha_title(title):
            return True
        # Только видимые элементы самой проверки, не фоновые токены/iframe.
        widgets = page.locator(
            '.CheckboxCaptcha, .AdvancedCaptcha, form[action*="checkcaptcha"], '
            'iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"][title*="challenge"]'
        )
        for i in range(await widgets.count()):
            if await widgets.nth(i).is_visible():
                return True
        return False

    async def fetch(self, pid, cfg, index, url, limit):
        public_url(url)
        if (pid, cfg.id) in self.skipped:
            raise SourceSkipped("Источник пропущен пользователем")
        tab = await self._tab(pid, cfg, index)
        async with tab.lock:
            try:
                tab.status, tab.action = "loading", "Открываю страницу"
                if tab.owner:
                    tab.resume.clear()
                    await asyncio.wait_for(tab.resume.wait(), self.wait_seconds)
                response = await tab.page.goto(url, wait_until="domcontentloaded", timeout=30000)
                # Даём клиентскому рендерингу вывести карточку товара; это ограниченное ожидание.
                try:
                    await tab.page.wait_for_load_state("networkidle", timeout=2500)
                except Exception:
                    pass
                deadline = time.monotonic() + self.wait_seconds
                challenged = False
                while True:
                    if tab.skipped or (pid, cfg.id) in self.skipped:
                        raise SourceSkipped("Источник пропущен пользователем")
                    if tab.owner:
                        await asyncio.wait_for(tab.resume.wait(), self.wait_seconds)
                    public_url(tab.page.url)
                    tab.title = (await tab.page.title())[:300]
                    html = await tab.page.content()
                    if len(html.encode()) > MAX_BODY:
                        raise ValueError("Страница превышает допустимый объём")
                    try:
                        title, text = html_text(html, limit, check_captcha=False)
                        if await self._captcha(tab.page, title):
                            raise NeedsLogin("Источник требует проверки капчи")
                        if not challenged and response and response.status >= 400:
                            raise httpx.HTTPStatusError(
                                "Источник ограничил доступ или вернул ошибку",
                                request=httpx.Request("GET", tab.page.url),
                                response=httpx.Response(response.status),
                            )
                        if not text.strip():
                            raise ValueError("Страница пуста")
                        break
                    except NeedsLogin:
                        challenged = True
                        await self._blocked(tab, "captcha", deadline=deadline)
                        # После клика отправка формы/редирект может ещё выполняться.
                        try:
                            await tab.page.wait_for_load_state("networkidle", timeout=2500)
                        except Exception:
                            pass
                if challenged and self.on_blocked:
                    await self.on_blocked(tab, "captcha", "resolved")
                tab.title, tab.status, tab.action = (
                    title,
                    "reading",
                    "Извлекаю цены и характеристики",
                )
                return CandidatePage(
                    url=tab.page.url, title=title, text=text, retrieved_at=datetime.now(UTC)
                )
            except BaseException:
                tab.status, tab.action = "error", "Не удалось прочитать страницу"
                raise

    async def skip_source(self, pid, source_id):
        await self.skip(pid, source_id)
        return {"detail": "Источник пропущен"}

    async def skip(self, pid, source_id):
        self.skipped.add((pid, source_id))
        for tab in self.tabs_for(pid):
            if tab.source_id == source_id:
                tab.skipped, tab.owner = True, None
                tab.action, tab.status = "Источник пропущен", "done"
                tab.resume.set()

    async def command(self, pid, owner, data):
        if not isinstance(data, dict):
            raise ValueError("Неверный формат действия")
        tab = self.get(pid, data.get("tab_id"))
        kind = data.get("type")
        if kind == "control":
            by = data.get("by")
            if by not in ("agent", "user"):
                raise ValueError("Неизвестный режим управления")
            if tab.owner not in (None, owner):
                raise ValueError("Вкладкой уже управляет другой наблюдатель")
            tab.owner = owner if by == "user" else None
            if by == "user":
                tab.resume.clear()
            if by == "agent":
                await self.release_inputs(tab)
                tab.resume.set()
            return tab
        if kind == "resume":
            if tab.owner not in (None, owner):
                raise ValueError("Вкладкой управляет другой наблюдатель")
            tab.owner = None
            await self.release_inputs(tab)
            tab.resume.set()
            return tab
        if tab.owner != owner:
            raise ValueError("Сначала возьмите управление вкладкой")
        if kind == "mouse":
            x, y = data.get("x"), data.get("y")
            if not all(isinstance(v, (int, float)) for v in (x, y)):
                raise ValueError("Неверные координаты")
            if not (0 <= x <= WIDTH and 0 <= y <= HEIGHT):
                raise ValueError("Координаты вне кадра")
            await tab.page.mouse.move(x, y)
            event, button = data.get("event"), data.get("button", "left")
            if button not in ("left", "right", "middle") or event not in ("down", "up", "move"):
                raise ValueError("Неверное действие мыши")
            if event in ("down", "up"):
                await getattr(tab.page.mouse, event)(button=button)
                if event == "down":
                    tab.buttons.add(button)
                else:
                    tab.buttons.discard(button)
        elif kind == "wheel":
            dx, dy = data.get("dx"), data.get("dy")
            if not all(isinstance(v, (int, float)) and abs(v) <= 10000 for v in (dx, dy)):
                raise ValueError("Неверная прокрутка")
            await tab.page.mouse.wheel(dx, dy)
        elif kind == "key":
            event, key = data.get("event"), data.get("key")
            if event not in ("down", "up") or not isinstance(key, str) or len(key) > 80:
                raise ValueError("Неверная клавиша")
            await getattr(tab.page.keyboard, event)(key)
            if event == "down":
                tab.pressed.add(key)
            else:
                tab.pressed.discard(key)
        elif kind == "text":
            value = data.get("text")
            if not isinstance(value, str) or len(value) > 10000:
                raise ValueError("Текст слишком длинный")
            await tab.page.keyboard.insert_text(value)
        else:
            raise ValueError("Неизвестное действие браузера")
        return tab

    async def release_inputs(self, tab):
        keys, buttons = list(tab.pressed), list(tab.buttons)
        tab.pressed.clear()
        tab.buttons.clear()
        for key in keys:
            try:
                await tab.page.keyboard.up(key)
            except Exception:
                pass
        for button in buttons:
            try:
                await tab.page.mouse.up(button=button)
            except Exception:
                pass

    def release(self, owner):
        for tab in self.tabs.values():
            if tab.owner == owner:
                tab.owner = None
                task = asyncio.create_task(self.release_inputs(tab))
                self.releases.add(task)
                task.add_done_callback(self.releases.discard)
                if not tab.blocked:
                    tab.resume.set()

    async def frame(self, tab):
        tab.title = (await tab.page.title())[:300]
        data = await tab.page.screenshot(
            type="jpeg", quality=90 if tab.blocked or tab.owner else 65, timeout=4000
        )
        return dict(
            type="frame",
            tab_id=tab.id,
            data=base64.b64encode(data).decode(),
            width=WIDTH,
            height=HEIGHT,
        )

    async def close(self):
        if self.releases:
            await asyncio.gather(*self.releases, return_exceptions=True)
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()
        self.tabs.clear()
        self.contexts.clear()
        self._browser = self._playwright = None
