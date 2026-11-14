from datetime import UTC, datetime
from typing import Protocol
from urllib.parse import urlsplit

import httpx

from app.config import Rules, SourceConfig
from app.llm.client import LLMFormatError, OpenRouterLLM
from app.models import Position, SkippedPage, SourceRun
from app.sources.base import SourceResult, source_error
from app.sources.fetch import fetch_page, public_url


class WebSearch(Protocol):
    async def search(self, query: str, max_results: int) -> list[tuple[str, str]]: ...


class OpenRouterWebSearch(OpenRouterLLM):
    async def search(self, query: str, max_results: int) -> list[tuple[str, str]]:
        message = await self._request(
            {
                "messages": [
                    {
                        "role": "system",
                        "content": "Найди страницы товаров с ценами по запросу. "
                        "Приведи ссылки на найденные источники. Не выдумывай URL.",
                    },
                    {"role": "user", "content": query},
                ],
                "plugins": [{"id": "web", "engine": "exa", "max_results": max_results}],
            }
        )
        annotations = message.get("annotations", [])
        if not isinstance(annotations, list):
            raise LLMFormatError("Поиск вернул неверный формат ссылок")
        results = []
        seen = set()
        for item in annotations:
            if not isinstance(item, dict) or item.get("type") != "url_citation":
                continue
            citation = item.get("url_citation", {})
            if not isinstance(citation, dict) or not isinstance(citation.get("url"), str):
                continue
            url = citation["url"]
            try:
                public_url(url)
            except ValueError:
                continue
            if url not in seen:
                seen.add(url)
                results.append((url, str(citation.get("title") or "")))
        return results[:max_results]


class WebSource:
    def __init__(self, cfg: SourceConfig, search: WebSearch, http: httpx.AsyncClient, fetcher=None):
        self.cfg, self._search, self.http = cfg, search, http
        self.fetcher = fetcher
        self.id, self.name, self.level = cfg.id, cfg.name, cfg.level

    async def search(self, position: Position, rules: Rules) -> SourceResult:
        run = SourceRun(
            source_id=self.id,
            name=self.name,
            level=self.level,
            position_index=position.index,
            status="empty",
            found=0,
            at=datetime.now(UTC),
        )
        result = SourceResult(run=run)
        run = result.run
        errors = []
        try:
            features = " ".join([c.value for c in position.characteristics if c.essential][:3])[
                :250
            ]
            base = f"{position.name} {features} {self.cfg.params.get('query_suffix', '')}".strip()
            sites = self.cfg.params.get("sites", [])
            queries = [f"{base} site:{site}" for site in sites] if sites else [base]
            seen = set()
            for query in queries:
                run.queries.append(query)
                try:
                    links = await self._search.search(query, rules.max_pages_per_source)
                except Exception as exc:
                    errors.append(source_error(exc))
                    continue
                for url, _ in links:
                    if url in seen or len(seen) >= rules.max_pages_per_source:
                        continue
                    # Ограничение sites действует и на фактически возвращённый URL.
                    host = (urlsplit(url).hostname or "").lower().removeprefix("www.")
                    if sites and not any(host == s or host.endswith("." + s) for s in sites):
                        continue
                    seen.add(url)
                    try:
                        page = (
                            await self.fetcher(self.cfg, position.index, url, rules.page_text_limit)
                            if self.fetcher
                            else await fetch_page(self.http, url, rules.page_text_limit)
                        )
                        final_host = (
                            (urlsplit(page.url).hostname or "").lower().removeprefix("www.")
                        )
                        if sites and not any(
                            final_host == s or final_host.endswith("." + s) for s in sites
                        ):
                            raise ValueError("Перенаправление за пределы настроенных сайтов")
                        result.pages.append(page)
                    except Exception as exc:
                        status, reason = source_error(exc)
                        errors.append((status, reason))
                        result.skipped.append(
                            SkippedPage(url=url, source_id=self.id, reason=reason)
                        )
                if len(seen) >= rules.max_pages_per_source:
                    break
        except Exception as exc:
            errors.append(source_error(exc))
        run.found = len(result.pages)
        run.status = "ok" if result.pages else errors[0][0] if errors else "empty"
        run.error = "; ".join(dict.fromkeys(e[1] for e in errors)) or None
        return result
