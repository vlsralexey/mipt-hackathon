"""ЕИС: строки исполненных контрактов, КТРУ и проверка неустоек.

Параметры выдачи — из §5.4.1 спецификации. Неподтверждённый параметр даты
не угадывается: глубина eis_years проверяется по дате заключения в карточке.
"""

import asyncio
import re
from datetime import UTC, date, datetime
from decimal import Decimal
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

import httpx
from selectolax.parser import HTMLParser

from app.config import Rules, SourceConfig
from app.models import Position, SkippedPage, SourceRun
from app.sources.base import CandidatePage, EisLine, SourceResult, source_error
from app.sources.fetch import fetch_html, html_text
from app.units import canonical_unit, parse_price

ROOT = "https://zakupki.gov.ru/epz/contract/"
SEARCH = ROOT + "search/results.html"
CARD = ROOT + "contractCard/"


def search_url(term: str, rules: Rules) -> str:
    return (
        SEARCH
        + "?"
        + urlencode(
            {
                "searchString": term,
                "morphology": "on",
                "fz44": "on",
                "contractStageList_1": "on",
                "contractStageList": "1",
                "sortBy": "UPDATE_DATE",
                "sortDirection": "false",
                "pageNumber": "1",
                "recordsPerPage": "_50",
            }
        )
    )


def parse_search_results(html: str) -> list[str]:
    result = []
    for a in HTMLParser(html).css("a[href]"):
        href = a.attributes["href"]
        if "contractCard/common-info.html" not in href:
            continue
        number = parse_qs(urlsplit(href).query).get("reestrNumber", [""])[0]
        if re.fullmatch(r"\d{19}", number) and number not in result:
            result.append(number)
    return result


def parse_lines(html: str) -> list[EisLine]:
    """Цена за единицу и количество контракта — разные колонки."""
    lines = []
    for table in HTMLParser(html).css("table"):
        headers = [
            " ".join(h.text(separator=" ", strip=True).split()).casefold()
            for h in table.css("thead th")
        ]
        price_col = next((i for i, h in enumerate(headers) if "цена за единицу" in h), None)
        unit_col = next((i for i, h in enumerate(headers) if "единица измерения" in h), None)
        name_col = next((i for i, h in enumerate(headers) if "наименование объекта" in h), None)
        if None in (price_col, unit_col, name_col):
            continue
        for row in table.css("tbody tr"):
            cells = row.css("td")
            if len(cells) <= max(price_col, unit_col, name_col):
                continue
            title = " ".join(cells[name_col].text(separator=" ", strip=True).split())
            index = re.match(r"(\d+)\.", title)
            if not index:
                continue
            unit = " ".join(cells[unit_col].text(separator=" ", strip=True).split())
            unit = re.sub(r"^[\d\s.,]+", "", unit)
            try:
                price = parse_price(cells[price_col].text(strip=True))
                unit = canonical_unit(unit)
            except ValueError:
                continue
            text = row.text(separator=" ", strip=True)
            vat, rate = "unknown", None
            if re.search(r"Ставка\s+НДС\s*:\s*Без\s+НДС", text, re.I):
                vat = "exempt"
            elif match := re.search(r"Ставка\s+НДС\s*:\s*(\d+(?:[.,]\d+)?)\s*%", text, re.I):
                vat, rate = "included", parse_price(match[1]) / Decimal(100)
            ktru = cells[name_col].css_first('a[href*="ktru-characteristics.html"]')
            lines.append(
                EisLine(
                    index=int(index[1]),
                    title=title,
                    price=price,
                    amount_unit=unit,
                    vat=vat,
                    vat_rate=rate,
                    ktru_url=ktru.attributes["href"] if ktru else None,
                )
            )
    return lines


def penalties(html: str) -> bool | None:
    """Проверяем именно колонку неустоек, а не случайное «Нет» на странице."""
    tree = HTMLParser(html)
    checked = False
    for table in tree.css("table, .tableBlock"):
        rows = table.css("tr") or table.css(".tableBlock__row")
        penalty_columns = []
        for row in rows:
            cells = row.css("th, td") or row.css(".tableBlock__col")
            texts = [" ".join(c.text(separator=" ", strip=True).split()) for c in cells]
            headers = [i for i, t in enumerate(texts) if "неустойк" in t.casefold()]
            if headers:
                penalty_columns = headers
                continue
            for column in penalty_columns:
                if column >= len(texts) or not texts[column]:
                    continue
                checked = True
                if texts[column].casefold().rstrip(".") != "нет":
                    return True
    return False if checked else None


def _card_link(href: str, base: str) -> str:
    url = urljoin(base, href)
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "zakupki.gov.ru":
        raise ValueError("Ссылка карточки ведёт за пределы ЕИС")
    return url


def contract_date(text: str) -> date | None:
    match = re.search(
        r"Дата\s+заключения(?:\s+контракта)?\s*:?\s*(\d{2}\.\d{2}\.\d{4})", text, re.I
    )
    if match:
        try:
            return datetime.strptime(match[1], "%d.%m.%Y").date()
        except ValueError:
            pass
    return None


class EisSource:
    def __init__(self, cfg: SourceConfig, http: httpx.AsyncClient, *, as_of: date | None = None):
        self.cfg, self.http = cfg, http
        self.id, self.name, self.level = cfg.id, cfg.name, cfg.level
        self.as_of = as_of or datetime.now(UTC).date()
        self._slots = asyncio.Semaphore(2)

    async def _html(self, url):
        async with self._slots:
            html, final, at = await fetch_html(self.http, url)
        html_text(html)  # Проверка капчи до разбора ссылок.
        return html, final, at

    async def _contract(
        self, number: str, rules: Rules
    ) -> tuple[CandidatePage | None, list[SkippedPage]]:
        skipped = []
        common_url = CARD + "common-info.html?" + urlencode({"reestrNumber": number})
        payment_url = (
            CARD + "payment-info-and-target-of-order.html?" + urlencode({"reestrNumber": number})
        )
        common, _, _ = await self._html(common_url)
        card_numbers = parse_search_results(common)
        if card_numbers and number not in card_numbers:
            raise ValueError("ЕИС вернула карточку другого контракта")
        _, common_text = html_text(common)
        when = contract_date(common_text)
        try:
            cutoff = self.as_of.replace(year=self.as_of.year - rules.eis_years)
        except ValueError:  # 29 февраля в невисокосном году.
            cutoff = self.as_of.replace(year=self.as_of.year - rules.eis_years, day=28)
        if when is not None and when < cutoff:
            return None, [
                SkippedPage(
                    url=common_url,
                    source_id=self.id,
                    reason=f"Дата контракта раньше глубины поиска: {rules.eis_years} лет",
                )
            ]
        process = next(
            (
                a.attributes["href"]
                for a in HTMLParser(common).css("a[href]")
                if "process-info.html" in a.attributes["href"]
            ),
            None,
        )
        penalty_state = None
        if process:
            try:
                process_html, _, _ = await self._html(_card_link(process, common_url))
                penalty_state = penalties(process_html)
            except Exception:
                pass
        if penalty_state is True:
            return None, [
                SkippedPage(
                    url=common_url,
                    source_id=self.id,
                    reason="По контракту начислены неустойки (штрафы, пени) — не используется",
                )
            ]
        payment, final_url, at = await self._html(payment_url)
        _, payment_text = html_text(payment)
        lines = parse_lines(payment)
        if not re.search(r"объект[ыа]?\s+закупки|цена\s+за\s+единицу", payment_text, re.I):
            raise ValueError("Не найдены объекты закупки в карточке ЕИС")
        text = [
            f"Контракт № {number}",
            "Общая информация:",
            common_text,
            "Объекты закупки (цены за единицу строки):",
            payment_text,
        ]
        seen = set()
        links = HTMLParser(payment).css("a[href]")
        for a in links:
            href = a.attributes["href"]
            if "ktru-characteristics.html" not in href or href in seen:
                continue
            if len(seen) >= 10:
                break
            seen.add(href)
            # Контекст строки сохраняет связь КТРУ с названием и фасовкой.
            parent = a.parent
            while parent.parent and parent.tag not in ("tr", "section") and len(parent.text()) < 80:
                parent = parent.parent
            context = " ".join(parent.text(separator=" ", strip=True).split())[:500]
            try:
                ktru, _, _ = await self._html(_card_link(href, payment_url))
                _, ktru_text = html_text(ktru)
                characteristics = {}
                for section in HTMLParser(ktru).css(".blockInfo__section"):
                    key, value = (
                        section.css_first(".section__title"),
                        section.css_first(".section__info"),
                    )
                    if key and value:
                        characteristics[" ".join(key.text(strip=True).split())] = " ".join(
                            value.text(separator=" ", strip=True).split()
                        )
                for line in lines:
                    if line.ktru_url == href:
                        line.characteristics.update(characteristics)
                text.append(f"Характеристики ТРУ, строка {len(seen)} ({context}):\n{ktru_text}")
            except Exception as exc:
                skipped.append(
                    SkippedPage(
                        url=urljoin(payment_url, href),
                        source_id=self.id,
                        reason="Не удалось загрузить характеристики ТРУ: " + source_error(exc)[1],
                    )
                )
        text.append(
            "Неустойки не начислены"
            if penalty_state is False
            else "Сведения о неустойках не найдены; отсутствие неустоек не проверено"
        )
        if when is None:
            text.append("Дата заключения не распознана; глубина поиска по дате не проверена")
        # Не режем хвост характеристик: лимит применяется к каждой вкладке, а не
        # к склейке, иначе существенные характеристики последних строк теряются.
        return CandidatePage(
            url=final_url,
            title=f"ЕИС, контракт № {number}",
            text="\n".join(t[: rules.page_text_limit] for t in text),
            retrieved_at=at,
            eis_lines=lines,
        ), skipped

    async def search(self, position: Position, rules: Rules) -> SourceResult:
        result = SourceResult(
            run=SourceRun(
                source_id=self.id,
                name=self.name,
                level=self.level,
                position_index=position.index,
                status="empty",
                found=0,
                at=datetime.now(UTC),
            )
        )
        errors = []
        try:
            numbers = []
            for term in position.search_terms or [position.name]:
                url = search_url(term, rules)
                result.run.queries.append(term)
                try:
                    html, _, _ = await self._html(url)
                    found = parse_search_results(html)
                    if not found and not re.search(
                        r"ничего не найдено|нет результатов|найдено\s*:?\s*0",
                        html_text(html)[1],
                        re.I,
                    ):
                        raise ValueError("Не распознана выдача ЕИС")
                    numbers.extend(n for n in found if n not in numbers)
                except Exception as exc:
                    errors.append(source_error(exc))
            for number in numbers[: rules.max_pages_per_source]:
                try:
                    page, skipped = await self._contract(number, rules)
                    result.skipped.extend(skipped)
                    if page:
                        result.pages.append(page)
                except Exception as exc:
                    status, reason = source_error(exc)
                    errors.append((status, reason))
                    result.skipped.append(
                        SkippedPage(
                            url=CARD + f"common-info.html?reestrNumber={number}",
                            source_id=self.id,
                            reason=reason,
                        )
                    )
        except Exception as exc:
            errors.append(source_error(exc))
        result.run.found = len(result.pages)
        result.run.status = "ok" if result.pages else errors[0][0] if errors else "empty"
        result.run.error = "; ".join(dict.fromkeys(e[1] for e in errors)) or None
        return result
