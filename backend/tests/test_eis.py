"""Синтетические HTML-тесты протокола; не заменяют реальные фикстуры ЕИС."""

from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fakes import paper_position
from test_sources import Search

from app.config import DEFAULT_CONFIG_DIR, Rules, SourceConfig, load_sources
from app.sources.eis import EisSource, parse_search_results, penalties, search_url
from app.sources.registry import build_adapters

NUMBER = "2610300092726000086"
SEARCH = f'<a href="/epz/contract/contractCard/common-info.html?reestrNumber={NUMBER}">Контракт</a>'
COMMON = (
    "<body>Дата заключения контракта 19.10.2026 Поставщик ИП ИНН 051205954080"
    '<a href="process-info.html?reestrNumber=' + NUMBER + '">Исполнение</a></body>'
)
PAYMENT = (
    "<body>Объекты закупки<table><tr><td>Бумага А4</td><td>291,40</td><td>пач</td>"
    '<td>Ставка НДС: Без НДС</td><td><a href="ktru-characteristics.html?contractSubjectId=10">'
    "Все характеристики ТРУ</a></td></tr></table></body>"
)
KTRU = "<body>Белизна по CIE 146 Плотность 80Грамм</body>"


def process(value="Нет"):
    return (
        f"<table><tr><th>Событие</th><th>Неустойки (штрафы, пени)</th></tr>"
        f"<tr><td>Исполнение</td><td>{value}</td></tr></table>"
    )


def cfg():
    return SourceConfig(id="eis", name="ЕИС", level=1, type="eis", price_final=True)


def test_search_numbers_and_filters():
    assert parse_search_results(SEARCH * 2) == [NUMBER]
    query = parse_qs(urlsplit(search_url("SvetoCopy", Rules())).query)
    assert query["contractStageList"] == ["1"] and query["fz44"] == ["on"]
    assert not any("okpd" in k.lower() for k in query)


@pytest.mark.parametrize(
    "html, expected",
    [
        (process(), False),
        (process("100,00 ₽"), True),
        ("<body>Неустойки Нет</body>", None),
        (process(""), None),
        (process("—"), True),
    ],
)
def test_penalties_require_explicit_column(html, expected):
    assert penalties(html) is expected


async def run_source(penalty="Нет", fail_tab=None, common=COMMON):
    def handler(request):
        name = request.url.path.rsplit("/", 1)[-1]
        pages = {
            "results.html": SEARCH,
            "common-info.html": common,
            "payment-info-and-target-of-order.html": PAYMENT,
            "ktru-characteristics.html": KTRU,
            "process-info.html": process(penalty),
        }
        return httpx.Response(404 if name == fail_tab else 200, text=pages[name])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        return await EisSource(cfg(), http, as_of=date(2026, 11, 14)).search(
            paper_position(), Rules()
        )


async def test_contract_contains_price_supplier_vat_and_ktru():
    result = await run_source()
    assert result.run.status == "ok" and len(result.pages) == 1
    text = result.pages[0].text
    assert all(s in text for s in ["291,40", "Без НДС", "19.10.2026", "051205954080", "80Грамм"])
    assert "payment-info-and-target-of-order" in result.pages[0].url


async def test_penalty_skips_whole_contract():
    result = await run_source(penalty="100,00 ₽")
    assert not result.pages and "неустойки" in result.skipped[0].reason


@pytest.mark.parametrize("tab", ["ktru-characteristics.html", "process-info.html"])
async def test_optional_tab_failure_does_not_lose_contract(tab):
    result = await run_source(fail_tab=tab)
    assert len(result.pages) == 1
    if "process" in tab:
        assert "не проверено" in result.pages[0].text
    else:
        assert result.skipped


async def test_payment_failure_skips_contract_and_old_date_is_filtered():
    result = await run_source(fail_tab="payment-info-and-target-of-order.html")
    assert not result.pages and result.run.status == "error" and result.skipped
    result = await run_source(common=COMMON.replace("19.10.2026", "19.10.2020"))
    assert not result.pages and "глубины поиска" in result.skipped[0].reason


async def test_unrecognized_html_is_error_not_empty_search():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, text="<body>Вёрстка изменилась</body>")
        )
    ) as http:
        result = await EisSource(cfg(), http).search(paper_position(), Rules())
    assert result.run.status == "error"


async def test_registry_local_settings_do_not_mutate_global_config():
    sources = load_sources(DEFAULT_CONFIG_DIR / "sources.yaml")
    before = [s.model_dump() for s in sources]
    async with httpx.AsyncClient() as http:
        adapters = build_adapters(
            sources,
            Search(),
            http,
            {
                "eis": {"enabled": False},
                "web_shops": {"sites": ["shop.ru"]},
            },
        )
    assert {a.id for a in adapters[1]} == {"web_suppliers"}
    assert adapters[2][0].cfg.params["sites"] == ["shop.ru"]
    assert before == [s.model_dump() for s in sources]


def test_packaged_ca_and_hostname_verification():
    import hashlib
    import ssl

    from app.sources.http import ROOT_CA, eis_ssl_context

    der = ssl.PEM_cert_to_DER_cert(ROOT_CA.read_text())
    assert hashlib.sha256(der).hexdigest() == (
        "d26d2d0231b7c39f92cc738512ba54103519e4405d68b5bd703e9788ca8ecf31"
    )
    context = eis_ssl_context()
    assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED


REAL = Path(__file__).parent / "fixtures" / "eis"


def test_real_search_and_process_snapshots():
    assert "3520300065426000009" in parse_search_results((REAL / "search.html").read_text())
    assert penalties((REAL / "process_2610300092726000086.html").read_text()) is False


async def test_real_common_and_payment_keep_precise_line_prices():
    number = "3520300065426000009"

    def handler(request):
        name = request.url.path.rsplit("/", 1)[-1]
        if name != "results.html" and parse_qs(request.url.query.decode()).get("reestrNumber") != [
            number
        ]:
            return httpx.Response(404)
        fixture = {
            "results.html": "search.html",
            "common-info.html": f"common_{number}.html",
            "payment-info-and-target-of-order.html": f"payment_{number}.html",
        }.get(name)
        return (
            httpx.Response(200, text=(REAL / fixture).read_text())
            if fixture
            else httpx.Response(404)
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await EisSource(cfg(), http, as_of=date(2026, 11, 14)).search(
            paper_position(search_terms=["бумага"]), Rules(max_pages_per_source=2)
        )
    assert len(result.pages) == 1
    assert all(s in result.pages[0].text for s in ["284,4102", "177,2408", "22%", "24.02.2026"])
    assert "не проверено" in result.pages[0].text  # Не подставляем исполнение другого контракта.


async def test_complete_real_contract_with_full_ktru_and_penalties():
    def handler(request):
        name = request.url.path.rsplit("/", 1)[-1]
        if name == "results.html":
            return httpx.Response(200, text=SEARCH)
        fixture = {
            "common-info.html": "common",
            "payment-info-and-target-of-order.html": "payment",
            "process-info.html": "process",
            "ktru-characteristics.html": "ktru",
        }[name]
        return httpx.Response(200, text=(REAL / f"{fixture}_{NUMBER}.html").read_text())

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await EisSource(cfg(), http, as_of=date(2026, 11, 14)).search(
            paper_position(), Rules()
        )
    assert len(result.pages) == 1 and not result.skipped
    text = result.pages[0].text
    assert all(s in text for s in ["291,40", "Без НДС", "051205954080", "80Грамм", "146"])
    assert "Неустойки не начислены" in text
    assert "ktru" not in text.lower()  # Читаемое содержимое, не URL вместо характеристик.
