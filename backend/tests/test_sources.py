import httpx
import pytest
from fakes import paper_position

from app.config import Rules, SourceConfig
from app.llm.client import LLMAuthError
from app.sources.fetch import NeedsLogin, fetch_page
from app.sources.web import OpenRouterWebSearch, WebSource


@pytest.fixture(autouse=True)
def no_retry_delay(monkeypatch):
    async def immediate(*args):
        pass

    monkeypatch.setattr("app.sources.fetch.asyncio.sleep", immediate)


async def test_fetch_strips_scripts_and_bounds_text():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(
                200,
                text="<title>Бумага</title><style>bad</style><script>secret()</script>"
                "<body>Цена 290 ₽</body>",
            )
        )
    ) as http:
        page = await fetch_page(http, "https://shop.ru/p", 100)
    assert page.title == "Бумага" and "290" in page.text
    assert "secret" not in page.text and "bad" not in page.text
    assert page.retrieved_at.tzinfo


async def test_fetch_retries_5xx_and_fails_4xx_without_retries():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(503 if len(calls) < 3 else 200, text="Цена")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        assert (await fetch_page(http, "https://shop.ru/p", 100)).text == "Цена"
    assert len(calls) == 3


@pytest.mark.parametrize(
    "url", ["file:///etc/passwd", "http://127.0.0.1/", "http://localhost/", "http://[::1]/"]
)
async def test_fetch_rejects_local_urls(url):
    async with httpx.AsyncClient() as http:
        with pytest.raises(ValueError):
            await fetch_page(http, url, 100)


async def test_fetch_checks_redirects_and_captcha():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(302, headers={"location": "http://127.0.0.1/"})
        )
    ) as http:
        with pytest.raises(ValueError):
            await fetch_page(http, "https://shop.ru/p", 100)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, text="<title>Captcha</title><body>Проверка</body>")
        )
    ) as http:
        with pytest.raises(NeedsLogin):
            await fetch_page(http, "https://shop.ru/p", 100)


class Search:
    def __init__(self, links=None, error=None):
        self.queries = []
        self.links = links or [("https://komus.ru/p", "Бумага")]
        self.error = error

    async def search(self, query, max_results):
        self.queries.append(query)
        if self.error:
            raise self.error
        return self.links


async def test_web_sites_dedup_and_partial_failure():
    search = Search(
        links=[
            ("https://komus.ru/p", ""),
            ("https://komus.ru/p", ""),
            ("https://komus.ru/bad", ""),
            ("https://other.ru/p", ""),
        ]
    )
    cfg = SourceConfig(id="web", name="Веб", type="web", level=1, params={"sites": ["komus.ru"]})
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(404 if r.url.path == "/bad" else 200, text="Бумага 290 ₽")
        )
    ) as http:
        result = await WebSource(cfg, search, http).search(paper_position(), Rules())
    assert len(result.pages) == 1 and len(result.skipped) == 1
    assert result.run.status == "ok" and result.run.error
    assert "site:komus.ru" in search.queries[0]


async def test_web_network_error_is_source_status():
    cfg = SourceConfig(id="web", name="Веб", type="web", level=1)
    async with httpx.AsyncClient() as http:
        result = await WebSource(cfg, Search(error=httpx.ConnectError("secret")), http).search(
            paper_position(), Rules()
        )
    assert result.run.status == "unavailable" and not result.pages
    assert "secret" not in result.run.error


async def test_openrouter_uses_citations_not_generated_links():
    def handler(request):
        import json

        body = json.loads(request.content)
        assert body["plugins"][0]["id"] == "web"
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "https://fake.ru/",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url_citation": {"url": "https://shop.ru/p", "title": "Цена"},
                                },
                                {"type": "url_citation", "url_citation": {"url": "file:///tmp/a"}},
                            ],
                        }
                    }
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        search = OpenRouterWebSearch("test-key", "test-model", http)
        assert await search.search("бумага", 3) == [("https://shop.ru/p", "Цена")]


async def test_search_auth_error_is_safe():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(401, json={"error": "test-key"}))
    ) as http:
        with pytest.raises(LLMAuthError, match="недействителен"):
            await OpenRouterWebSearch("test-key", "test-model", http).search("цена", 3)
