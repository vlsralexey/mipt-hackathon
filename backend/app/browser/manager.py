"""Один Chromium, изолированные контексты закупок, независимые наблюдатели."""

import asyncio
import base64
import ipaddress
import re
import socket
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from app.sources.base import CandidatePage
from app.sources.fetch import MAX_BODY, NeedsLogin, captcha_title, html_text, public_url

WIDTH, HEIGHT = 1280, 800
MIN_WIDTH, MAX_WIDTH, MIN_HEIGHT, MAX_HEIGHT = 1024, 1440, 600, 1100
GOTO_SECONDS = 30
# Старые простаивающие вкладки закрываются, чтобы Chromium не копил память.
MAX_TABS = 12
MAX_POPUP_TABS = 24
JOURNAL_SIZE = 50
CRASHED = "Страница аварийно закрылась в браузере"
CURSORS = {
    "default", "pointer", "text", "crosshair", "move", "grab", "grabbing", "not-allowed",
    "wait", "progress", "help", "vertical-text", "cell", "copy", "alias", "context-menu",
    "no-drop", "all-scroll", "col-resize", "row-resize", "ew-resize", "ns-resize",
    "nesw-resize", "nwse-resize", "zoom-in", "zoom-out", "none",
}  # fmt: skip
CURSOR_JS = """([x, y]) => {
  let el = document.elementFromPoint(x, y);
  while (el && el.nodeType === 1) {
    const c = getComputedStyle(el).cursor;
    if (c && c !== 'auto') return c;
    if (el.isContentEditable || el.matches('textarea, input:not([type=button]):not('
      + '[type=submit]):not([type=checkbox]):not([type=radio]):not([type=range])')) return 'text';
    if (el.matches('a[href], button, select, summary, label, [role=button], input')) {
      return 'pointer';
    }
    el = el.parentElement;
  }
  return 'default';
}"""
NET_REASONS = (
    ("ERR_NAME_NOT_RESOLVED", "Сайт не найден"),
    ("ERR_CERT_", "У сайта недействительный сертификат"),
    ("ERR_SSL_", "Не удалось установить защищённое соединение"),
    ("TIMED_OUT", f"Сайт не ответил за {GOTO_SECONDS} секунд"),
    ("ERR_TOO_MANY_REDIRECTS", "Сайт зациклил перенаправления"),
    ("ERR_BLOCKED_BY_CLIENT", "Адрес страницы закрыт для проверки"),
    ("ERR_ABORTED", "Загрузка страницы прервана"),
)


class SourceSkipped(ValueError):
    pass


class PageUnavailable(ValueError):
    """Страница не открылась; текст исключения готов для отчёта и журнала."""


def navigation_error(exc: BaseException) -> PageUnavailable | None:
    """Ошибки Playwright → понятная причина; остальные исключения не трогаем."""
    if isinstance(exc, PageUnavailable):
        return exc
    if not type(exc).__module__.startswith("playwright"):
        return None
    text = str(exc)
    if "crash" in text.lower():
        return PageUnavailable(CRASHED)
    if type(exc).__name__ == "TargetClosedError" or "has been closed" in text:
        return PageUnavailable("Вкладка закрылась во время загрузки")
    if "Download is starting" in text:
        return PageUnavailable("Ссылка ведёт на файл, а не на страницу")
    if type(exc).__name__ == "TimeoutError":
        return PageUnavailable(f"Сайт не ответил за {GOTO_SECONDS} секунд")
    match = re.search(r"net::(ERR_[A-Z0-9_]+)", text)
    if match:
        code = match.group(1)
        reason = next((r for key, r in NET_REASONS if key in code), None)
        return PageUnavailable(reason or "Сайт недоступен: ошибка сети")
    return None


def domain(url: str) -> str:
    return (urlsplit(url).hostname or "").lower().removeprefix("www.")


def viewport_for(width, height):
    """Размер панели → viewport страницы в разумных пределах настольной вёрстки."""
    if not all(isinstance(v, (int, float)) and 0 < v < 10000 for v in (width, height)):
        raise ValueError("Неверный размер области просмотра")
    w = int(max(MIN_WIDTH, min(MAX_WIDTH, round(width))))
    h = int(max(MIN_HEIGHT, min(MAX_HEIGHT, round(w * height / width))))
    return w, h


def _iso(value):
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


@dataclass
class Cast:
    session: object
    page: object
    params: tuple


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
    target_url: str = ""
    error: str | None = None
    needs: str | None = None
    deadline: datetime | None = None
    wait_seconds: int | None = None
    popup: bool = False
    viewport: tuple[int, int] = (WIDTH, HEIGHT)
    watchers: dict = field(default_factory=dict)
    cast: Cast | None = None
    cast_unsupported: bool = False
    frame: dict | None = None
    frame_seq: int = 0
    nav_blocked: asyncio.Event = field(default_factory=asyncio.Event)
    doc_status: int | None = None
    recovering: bool = False

    def url(self):
        raw = self.page.url or ""
        if self.target_url and raw.startswith(("chrome-error:", "about:")):
            return self.target_url
        return raw

    def state(self):
        if self.skipped:
            return "skipped"
        if self.blocked:
            return "needs_user"
        if self.status == "waiting":
            return "needs_user"
        return self.status if self.status in ("loading", "reading", "error", "done") else "loading"

    def public(self):
        url = self.url()
        waiting = self.blocked
        return dict(
            id=self.id,
            procurement_id=self.procurement_id,
            source_id=self.source_id,
            source_name=self.name,
            position_index=self.position_index,
            url=url,
            domain=domain(url),
            title=self.title,
            status=self.status,
            state=self.state(),
            action=self.action,
            blocked=self.blocked,
            needs=self.needs if waiting else None,
            deadline=_iso(self.deadline) if waiting else None,
            wait_seconds=self.wait_seconds if waiting else None,
            error=self.error if self.status in ("error", "done") else None,
            popup=self.popup,
            controlled=self.owner is not None,
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
        self.journals = defaultdict(lambda: deque(maxlen=JOURNAL_SIZE))
        self._journal_seq = 0
        self.journal_changed = asyncio.Event()

    # Фоновые задачи держим ссылкой, иначе asyncio может их собрать.
    def _spawn(self, coro):
        task = asyncio.create_task(coro)
        self.releases.add(task)
        task.add_done_callback(self.releases.discard)
        return task

    def log(self, pid, kind, text, tab=None, *, url=None, **extra):
        self._journal_seq += 1
        url = url if url is not None else (tab.url() if tab else "")
        event = dict(
            id=self._journal_seq,
            at=_iso(datetime.now(UTC)),
            kind=kind,
            text=text,
            position_index=extra.pop("position_index", tab.position_index if tab else None),
            source_id=extra.pop("source_id", tab.source_id if tab else None),
            source_name=extra.pop("source_name", tab.name if tab else None),
            domain=domain(url),
            url=url,
            tab_id=tab.id if tab else None,
            price=extra.pop("price", None),
            amount=extra.pop("amount", None),
            unit=extra.pop("unit", None),
        )
        self.journals[pid].append(event)
        self.journal_changed.set()
        return event

    def journal(self, pid, after=0):
        return [e for e in self.journals.get(pid, ()) if e["id"] > after]

    def page_result(self, pid, data):
        """Итог разбора страницы конвейером: цены или причина пропуска."""
        url = str(data.get("url") or "")
        offers = data.get("offers") or []
        common = dict(
            position_index=data.get("position_index"),
            source_id=data.get("source_id"),
            source_name=data.get("source_name"),
        )
        tab = next(
            (
                t
                for t in self.tabs_for(pid)
                if t.source_id == common["source_id"] and t.target_url == url
            ),
            None,
        )
        site = domain(url) or "источник"
        for offer in offers[:3]:
            price = _money(offer.get("price"))
            amount, unit = offer.get("amount"), offer.get("unit")
            text = f"{site}: цена {price}" if price else f"{site}: найдено предложение"
            if price and amount and unit:
                text += f" за {_number(amount)} {unit}"
            self.log(
                pid, "found", text, tab, url=url, price=_plain(offer.get("price")),
                amount=_plain(amount), unit=unit, **common,
            )  # fmt: skip
        if not offers:
            reason = data.get("reason") or "нет предложений по позиции"
            self.log(pid, "skipped", f"{site}: {_lower(reason)}", tab, url=url, **common)
        if tab and tab.status == "reading":
            tab.status = "done"
            tab.action = f"Найдено предложений: {len(offers)}" if offers else "Предложений нет"

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
            # Chromium не завершает goto, если прервать перенаправление: сообщаем вкладке сами.
            with suppress(Exception):
                request = route.request
                if request.is_navigation_request():
                    page = request.frame.page
                    if request.frame == page.main_frame:
                        tab = next((t for t in self.tabs.values() if t.page is page), None)
                        if tab:
                            tab.nav_blocked.set()
            await route.abort()

    async def _context(self, pid):
        async with self._lock:
            if self._browser is None:
                from playwright.async_api import async_playwright

                if self._playwright is None:
                    self._playwright = await async_playwright().start()
                try:
                    browser = await self._playwright.chromium.launch(
                        headless=True, args=["--disable-dev-shm-usage"]
                    )
                except Exception:
                    await self._playwright.stop()
                    self._playwright = None
                    raise ValueError(
                        "Chromium не установлен. Выполните make browser-setup "
                        "или пересоберите Docker."
                    ) from None
                self._browser = browser
                browser.on("disconnected", lambda *_: self._disconnected(browser))
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
                context.on("page", lambda page: self._spawn(self._popup(pid, page)))
            return self.contexts[pid]

    def _disconnected(self, browser):
        """Процесс Chromium завершился: следующая загрузка запустит новый."""
        if self._browser is not browser:
            return
        self._browser = None
        self.contexts.clear()
        for tab in list(self.tabs.values()):
            self.tabs.pop(tab.id, None)
            if tab.lock.locked():
                tab.status, tab.error = "error", "Браузер перезапускается"
        self.keys.clear()

    async def _popup(self, pid, page):
        # new_page also triggers this event; its creator registers it first.
        await asyncio.sleep(0)
        if any(tab.page is page for tab in self.tabs.values()):
            return
        opener = await page.opener()
        parent = next((t for t in self.tabs.values() if t.page is opener), None)
        if parent is None:
            return
        if len(self.tabs_for(pid)) >= MAX_POPUP_TABS:
            await page.close()
            return
        tab = self._register(pid, parent.source_id, parent.name, parent.position_index, page)
        tab.popup = True
        tab.status, tab.action = "reading", "Сайт открыл новую вкладку"

    def _register(self, pid, source_id, name, index, page):
        tab = Tab(uuid4().hex, pid, source_id, name, page, index)
        self.tabs[tab.id] = tab
        self._attach(tab, page)
        return tab

    def _attach(self, tab, page):
        tab.page = page
        page.on("close", lambda *_: self._closed(tab, page))
        page.on("crash", lambda *_: self._spawn(self._crashed(tab, page)))
        page.on("dialog", lambda dialog: self._spawn(dialog.dismiss()))
        page.on("response", lambda response: self._response(tab, page, response))

    def _closed(self, tab, page):
        if tab.page is page and not tab.recovering:
            self.tabs.pop(tab.id, None)
            tab.cast = None

    def _response(self, tab, page, response):
        with suppress(Exception):
            request = response.request
            if request.is_navigation_request() and request.frame == page.main_frame:
                tab.doc_status = response.status

    async def _crashed(self, tab, page):
        """Сбой рендерера: вкладка остаётся в списке и получает новую страницу."""
        if tab.page is not page or tab.recovering:
            return
        tab.status, tab.error, tab.action = "error", CRASHED, "Открываю вкладку заново"
        tab.cast, tab.frame = None, None
        context = self.contexts.get(tab.procurement_id)
        if tab.popup or context is None:
            self.tabs.pop(tab.id, None)
            with suppress(Exception):
                await page.close()
            return
        tab.recovering = True
        try:
            fresh = await context.new_page()
            self._attach(tab, fresh)
            if tab.viewport != (WIDTH, HEIGHT):
                with suppress(Exception):
                    await fresh.set_viewport_size(
                        {"width": tab.viewport[0], "height": tab.viewport[1]}
                    )
            tab.action = "Вкладка открыта заново"
            self.log(tab.procurement_id, "error", "Вкладка аварийно закрылась, открыта заново", tab)
        except Exception:
            self.tabs.pop(tab.id, None)
        finally:
            tab.recovering = False
        with suppress(Exception):
            await page.close()

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
                    with suppress(Exception):
                        await context.close()
                for tab in self.tabs_for(pid):
                    self.tabs.pop(tab.id, None)
                self.keys = {k: v for k, v in self.keys.items() if k[0] != pid}
                self.skipped = {k for k in self.skipped if k[0] != pid}

    def tabs_for(self, pid):
        return [t for t in self.tabs.values() if t.procurement_id == pid]

    def get(self, pid, tab_id):
        tab = self.tabs.get(tab_id)
        if tab is None or tab.procurement_id != pid:
            raise ValueError("Вкладка уже закрыта или недоступна")
        return tab

    async def _close_tab(self, tab):
        self.tabs.pop(tab.id, None)
        self.keys = {k: v for k, v in self.keys.items() if v != tab.id}
        with suppress(Exception):
            await tab.page.close()

    async def _tab(self, pid, cfg, index):
        key = (pid, cfg.id, index)
        tab = self.tabs.get(self.keys.get(key))
        if tab is not None and not tab.page.is_closed():
            return tab
        tabs = self.tabs_for(pid)
        if len(tabs) >= MAX_TABS:
            idle = [
                t
                for t in tabs
                if not t.lock.locked() and not t.blocked and t.owner is None and not t.watchers
            ]
            for old in idle[: len(tabs) - MAX_TABS + 1]:
                await self._close_tab(old)
        context = await self._context(pid)
        page = await context.new_page()
        tab = self._register(pid, cfg.id, cfg.name, index, page)
        self.keys[key] = tab.id
        return tab

    async def _blocked(self, tab, reason, *, deadline=None):
        tab.blocked, tab.status = True, "waiting"
        tab.action = "Жду проверки капчи или входа"
        tab.needs = "login" if reason == "login" else "captcha"
        remaining = self.wait_seconds if deadline is None else deadline - time.monotonic()
        tab.wait_seconds = int(self.wait_seconds)
        tab.deadline = datetime.now(UTC) + timedelta(seconds=max(0, remaining))
        tab.resume.clear()
        if self.on_blocked:
            await self.on_blocked(tab, reason, "waiting")
        try:
            await asyncio.wait_for(tab.resume.wait(), max(0, remaining))
        except TimeoutError:
            tab.skipped = True
        finally:
            tab.blocked = False
            tab.owner = None
            tab.deadline = None
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

    async def _challenge_text(self, page):
        """Короткая страница защиты от ботов: проверяем видимый текст, не только title."""
        try:
            text = await page.evaluate(
                "document.body ? document.body.innerText.slice(0, 1500) : ''"
            )
        except Exception:
            return False
        return isinstance(text, str) and len(text) < 1500 and captcha_title(text)

    async def _navigated(self, page, seconds):
        """Защита от ботов часто сама перезагружает страницу через пару секунд."""
        try:
            await page.wait_for_event(
                "framenavigated",
                predicate=lambda frame: frame == page.main_frame,
                timeout=seconds * 1000,
            )
        except Exception:
            return False
        with suppress(Exception):
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        with suppress(Exception):
            await page.wait_for_load_state("networkidle", timeout=2500)
        return True

    async def _goto(self, tab, url):
        tab.nav_blocked = asyncio.Event()
        tab.doc_status = None
        goto = asyncio.ensure_future(
            tab.page.goto(url, wait_until="domcontentloaded", timeout=GOTO_SECONDS * 1000)
        )
        blocked = asyncio.ensure_future(tab.nav_blocked.wait())
        try:
            await asyncio.wait({goto, blocked}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            blocked.cancel()
        if goto.done():
            return goto.result()
        goto.add_done_callback(lambda f: f.cancelled() or f.exception())
        goto.cancel()
        raise PageUnavailable("Страница перенаправила на закрытый адрес")

    async def _blank(self, tab):
        """Останавливаем загрузку, чтобы вкладка не осталась на служебной странице."""
        with suppress(Exception):
            await tab.page.goto("about:blank", timeout=5000)

    async def fetch(self, pid, cfg, index, url, limit):
        public_url(url)
        if (pid, cfg.id) in self.skipped:
            raise SourceSkipped("Источник пропущен пользователем")
        tab = await self._tab(pid, cfg, index)
        async with tab.lock:
            try:
                tab.status, tab.action, tab.error = "loading", "Открываю страницу", None
                tab.target_url, tab.title = url, ""
                if tab.owner:
                    tab.resume.clear()
                    await asyncio.wait_for(tab.resume.wait(), self.wait_seconds)
                response = await self._goto(tab, url)
                if tab.page.url.startswith("chrome-error:"):
                    raise PageUnavailable("Сайт недоступен: ошибка сети")
                self.log(pid, "opened", f"Открыта страница {domain(tab.page.url)}", tab)
                tab.action = "Жду загрузки страницы"
                # Даём клиентскому рендерингу вывести карточку товара; это ограниченное ожидание.
                try:
                    await tab.page.wait_for_load_state("networkidle", timeout=2500)
                except Exception:
                    pass
                deadline = time.monotonic() + self.wait_seconds
                challenged = False
                hops = 0
                while True:
                    if tab.skipped or (pid, cfg.id) in self.skipped:
                        raise SourceSkipped("Источник пропущен пользователем")
                    if tab.owner:
                        await asyncio.wait_for(tab.resume.wait(), self.wait_seconds)
                    if tab.page.url.startswith("chrome-error:"):
                        raise PageUnavailable("Сайт недоступен: ошибка сети")
                    try:
                        public_url(tab.page.url)
                    except ValueError:
                        raise PageUnavailable("Страница перенаправила на закрытый адрес") from None
                    tab.title = (await tab.page.title())[:300]
                    html = await tab.page.content()
                    if len(html.encode()) > MAX_BODY:
                        raise PageUnavailable("Страница слишком большая")
                    status = tab.doc_status or (response.status if response else None)
                    try:
                        title, text = html_text(html, limit, check_captcha=False)
                        if await self._captcha(tab.page, title):
                            raise NeedsLogin("Источник требует проверки капчи")
                        if not challenged and status and status >= 400:
                            if await self._challenge_text(tab.page):
                                raise NeedsLogin("Источник требует проверки капчи")
                            if hops < 3 and await self._navigated(tab.page, 6):
                                hops += 1
                                continue
                            raise httpx.HTTPStatusError(
                                "Источник ограничил доступ или вернул ошибку",
                                request=httpx.Request("GET", tab.page.url),
                                response=httpx.Response(status),
                            )
                        if not text.strip():
                            raise PageUnavailable("Страница пуста или не читается")
                        break
                    except NeedsLogin:
                        if not challenged:
                            site = domain(tab.page.url)
                            self.log(pid, "waiting", f"{site} просит пройти проверку", tab)
                        challenged = True
                        await self._blocked(tab, "captcha", deadline=deadline)
                        # После клика отправка формы/редирект может ещё выполняться.
                        try:
                            await tab.page.wait_for_load_state("networkidle", timeout=2500)
                        except Exception:
                            pass
                if challenged:
                    self.log(pid, "resolved", f"Проверка на {domain(tab.page.url)} пройдена", tab)
                    if self.on_blocked:
                        await self.on_blocked(tab, "captcha", "resolved")
                tab.title, tab.status, tab.action = (
                    title,
                    "reading",
                    "Извлекаю цены и характеристики",
                )
                return CandidatePage(
                    url=tab.page.url, title=title, text=text, retrieved_at=datetime.now(UTC)
                )
            except BaseException as exc:
                mapped = navigation_error(exc) if isinstance(exc, Exception) else None
                if isinstance(exc, SourceSkipped):
                    tab.status, tab.action, tab.error = "done", "Источник пропущен", str(exc)
                else:
                    tab.status, tab.action = "error", "Не удалось прочитать страницу"
                    tab.error = str(mapped) if mapped else _reason(exc)
                if isinstance(exc, Exception) and not isinstance(exc, asyncio.CancelledError):
                    site = domain(url)
                    self.log(pid, "skipped", f"{site}: {_lower(tab.error)}", tab, url=url)
                if mapped is not None:
                    if str(mapped) != CRASHED:
                        await self._blank(tab)
                    raise mapped from exc
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
        width, height = tab.viewport
        if kind == "mouse":
            x, y = data.get("x"), data.get("y")
            if not all(isinstance(v, (int, float)) for v in (x, y)):
                raise ValueError("Неверные координаты")
            if not (0 <= x <= width and 0 <= y <= height):
                raise ValueError("Координаты вне кадра")
            event, button = data.get("event"), data.get("button", "left")
            count = data.get("click_count", 1)
            if button not in ("left", "right", "middle") or event not in ("down", "up", "move"):
                raise ValueError("Неверное действие мыши")
            if count not in (1, 2, 3):
                raise ValueError("Неверное число нажатий")
            await tab.page.mouse.move(x, y)
            if event in ("down", "up"):
                await getattr(tab.page.mouse, event)(button=button, click_count=count)
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

    async def cursor(self, tab, x, y):
        try:
            value = await tab.page.evaluate(CURSOR_JS, [x, y])
        except Exception:
            return "default"
        return value if value in CURSORS else "default"

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
        for tab in list(self.tabs.values()):
            if tab.owner == owner:
                tab.owner = None
                self._spawn(self.release_inputs(tab))
                if not tab.blocked:
                    tab.resume.set()
            if owner in tab.watchers:
                self.unwatch(tab, owner)

    # --- Кадры: CDP screencast только для вкладок, за которыми кто-то наблюдает.

    def _cast_params(self, tab):
        width, height = tab.viewport
        if tab.blocked or tab.owner:
            return ("jpeg", 85, width, height, 1)
        return ("jpeg", 60, width, height, 2)

    async def set_viewport(self, tab, owner, width, height):
        size = viewport_for(width, height)
        if tab.owner not in (None, owner):
            return tab.viewport
        if abs(size[0] - tab.viewport[0]) < 16 and abs(size[1] - tab.viewport[1]) < 16:
            return tab.viewport
        try:
            await tab.page.set_viewport_size({"width": size[0], "height": size[1]})
        except Exception:
            return tab.viewport
        tab.viewport = size
        return size

    def watch(self, tab, key):
        event = tab.watchers.get(key)
        if event is None:
            event = tab.watchers[key] = asyncio.Event()
        if tab.frame:
            event.set()
        return event

    def unwatch(self, tab, key):
        tab.watchers.pop(key, None)
        if not tab.watchers and tab.cast:
            self._spawn(self._stop_cast(tab))

    async def ensure_cast(self, tab):
        """Запускает или перезапускает screencast при смене качества и размера."""
        if not tab.watchers:
            await self._stop_cast(tab)
            return False
        if tab.cast_unsupported:
            return False
        params = self._cast_params(tab)
        cast = tab.cast
        if cast and cast.page is tab.page and cast.params == params:
            return True
        await self._stop_cast(tab)
        page = tab.page
        try:
            session = await page.context.new_cdp_session(page)
        except Exception:
            tab.cast_unsupported = True
            return False
        cast = Cast(session, page, params)
        tab.cast = cast
        session.on("Page.screencastFrame", lambda event: self._spawn(self._frame(tab, cast, event)))
        fmt, quality, width, height, nth = params
        try:
            await session.send(
                "Page.startScreencast",
                dict(
                    format=fmt,
                    quality=quality,
                    maxWidth=width,
                    maxHeight=height,
                    everyNthFrame=nth,
                ),
            )
        except Exception:
            tab.cast = None
            return False
        return True

    async def _stop_cast(self, tab):
        cast, tab.cast = tab.cast, None
        if not cast:
            return
        with suppress(Exception):
            await cast.session.send("Page.stopScreencast")
        with suppress(Exception):
            await cast.session.detach()

    async def _frame(self, tab, cast, event):
        # Подтверждаем сразу: Chromium не пришлёт следующий кадр без ack.
        with suppress(Exception):
            await cast.session.send("Page.screencastFrameAck", {"sessionId": event["sessionId"]})
        if tab.cast is not cast or tab.page is not cast.page:
            return
        meta = event.get("metadata") or {}
        width, height = tab.viewport
        tab.frame = dict(
            type="frame",
            tab_id=tab.id,
            data=event["data"],
            format="jpeg",
            width=round(meta.get("deviceWidth") or width),
            height=round(meta.get("deviceHeight") or height),
            scroll_x=meta.get("scrollOffsetX", 0),
            scroll_y=meta.get("scrollOffsetY", 0),
            page_scale=meta.get("pageScaleFactor", 1),
            offset_top=meta.get("offsetTop", 0),
            timestamp=meta.get("timestamp"),
            source="screencast",
        )
        self._publish(tab)

    def _publish(self, tab):
        tab.frame_seq += 1
        for event in tab.watchers.values():
            event.set()

    async def frame(self, tab):
        """Одиночный снимок, если screencast недоступен или ещё не прислал кадр."""
        tab.title = (await tab.page.title())[:300] or tab.title
        _, quality, *_ = self._cast_params(tab)
        data = await tab.page.screenshot(type="jpeg", quality=quality, timeout=4000)
        width, height = tab.viewport
        tab.frame = dict(
            type="frame",
            tab_id=tab.id,
            data=base64.b64encode(data).decode(),
            format="jpeg",
            width=width,
            height=height,
            scroll_x=0,
            scroll_y=0,
            page_scale=1,
            offset_top=0,
            timestamp=time.time(),
            source="snapshot",
        )
        self._publish(tab)
        return tab.frame

    async def close(self):
        if self.releases:
            await asyncio.gather(*self.releases, return_exceptions=True)
        if self._browser:
            with suppress(Exception):
                await self._browser.close()
        if self._playwright:
            await self._playwright.stop()
        self.tabs.clear()
        self.contexts.clear()
        self._browser = self._playwright = None


def _reason(exc):
    from app.sources.base import source_error

    try:
        return source_error(exc)[1]
    except Exception:
        return "Не удалось прочитать страницу"


def _lower(text):
    return text[:1].lower() + text[1:] if text else text


def _plain(value):
    return None if value is None else str(value)


def _number(value):
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        return str(value)
    return f"{number.normalize():f}".replace(".", ",")


def _money(value):
    if value is None:
        return None
    try:
        number = Decimal(str(value)).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None
    whole, cents = f"{number:,.2f}".split(".")
    return f"{whole.replace(',', ' ')},{cents} ₽"
