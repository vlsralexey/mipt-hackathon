import asyncio
import ipaddress
import re
from datetime import UTC, datetime
from urllib.parse import urljoin, urlsplit

import httpx
from selectolax.parser import HTMLParser

from app.sources.base import CandidatePage

MAX_BODY = 5 * 1024 * 1024
USER_AGENT = "Mozilla/5.0 (compatible; NMCKResearch/0.1; public procurement research)"


class NeedsLogin(ValueError):
    pass


def captcha_title(title: str) -> bool:
    return bool(
        re.search(
            r"captcha|капча|проверка (?:браузера|безопасности)|"
            r"(?:подтвердите|докажите|verify).{0,30}(?:робот|human)|"
            r"вы не робот|are you (?:a )?robot|just a moment",
            title,
            re.I,
        )
    )


def public_url(url: str) -> str:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower().rstrip(".")
    if (
        parts.scheme not in ("http", "https")
        or not host
        or parts.username is not None
        or parts.password is not None
        or host == "localhost"
        or host.endswith((".localhost", ".local", ".internal"))
    ):
        raise ValueError("Разрешены только публичные HTTP/HTTPS-страницы")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if "." not in host or host.isdigit():
            raise ValueError("Недопустимый адрес страницы") from None
    else:
        if not address.is_global:
            raise ValueError("Локальные сетевые адреса не разрешены")
    return url


def html_text(
    html: str, limit: int | None = None, *, check_captcha: bool = True
) -> tuple[str, str]:
    tree = HTMLParser(html)
    title = tree.css_first("title")
    title_text = title.text(strip=True) if title else ""
    # Токены и iframe reCAPTCHA/SmartCaptcha встроены и в обычные карточки.
    # В браузере видимость активной проверки проверяется отдельно.
    if check_captcha and captcha_title(title_text):
        raise NeedsLogin("Источник требует проверки капчи")
    for node in tree.css("script, style, noscript, svg, header, footer, nav, .header, .footer"):
        node.decompose()
    root = tree.body or tree.root
    text = root.text(separator="\n", strip=True) if root else ""
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n(?:[ \t]*\n)+", "\n", text)
    return title_text, text if limit is None else text[:limit]


async def fetch_html(http: httpx.AsyncClient, url: str) -> tuple[str, str, datetime]:
    """Ограничиваем объём до декодирования; каждый redirect проверяется отдельно."""
    original = public_url(url)
    for attempt in range(3):
        try:
            current = original
            for _ in range(6):
                async with http.stream(
                    "GET",
                    current,
                    headers={"User-Agent": USER_AGENT},
                    timeout=20,
                    follow_redirects=False,
                ) as response:
                    if response.is_redirect:
                        current = public_url(urljoin(current, response.headers["location"]))
                        continue
                    response.raise_for_status()
                    kind = response.headers.get("content-type", "text/html").lower()
                    if not any(t in kind for t in ("text/html", "text/plain", "xhtml")):
                        raise ValueError("Источник вернул страницу неподдерживаемого типа")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_BODY:
                            raise ValueError("Страница превышает допустимый объём")
                    # ЕИС использует UTF-8; charset в ответе имеет приоритет.
                    encoding = response.charset_encoding or "utf-8"
                    return (
                        body.decode(encoding, errors="replace"),
                        str(response.url),
                        datetime.now(UTC),
                    )
            raise ValueError("Слишком много перенаправлений")
        except (httpx.RequestError, httpx.HTTPStatusError) as exc:
            retry = isinstance(exc, httpx.RequestError) or exc.response.status_code >= 500
            retry = retry or (
                isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429
            )
            if not retry or attempt == 2:
                raise
            await asyncio.sleep(2**attempt)
    raise AssertionError("Исчерпаны попытки загрузки")


async def fetch_page(http: httpx.AsyncClient, url: str, limit: int) -> CandidatePage:
    html, final_url, at = await fetch_html(http, url)
    title, text = html_text(html, limit)
    if not text.strip():
        raise ValueError("Страница пуста или требует JavaScript")
    return CandidatePage(url=final_url, title=title, text=text, retrieved_at=at)
