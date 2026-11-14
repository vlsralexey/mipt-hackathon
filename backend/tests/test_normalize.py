from datetime import date
from decimal import Decimal as D

import pytest
from fakes import entry, offer

from app.config import DeliveryPolicy, Rules
from app.models import Basis, DeliveryResolution, IndexResolution, VatResolution
from app.pipeline.calc import calculate, find_outliers, money
from app.pipeline.normalize import (
    adjusted_price,
    diagnose_spread,
    index_price,
    normalize_price,
    pick_per_supplier,
    resolve_delivery,
    resolve_vat,
    supplier_key,
)
from app.units import UnitMismatch


@pytest.mark.parametrize(
    "price,amount,unit,basis,expected",
    [
        ("1450", "5", "пачка", Basis(unit="пачка"), "290.00"),
        ("15000", "25", "мкг", Basis(unit="мкг", per_tz_unit=10), "6000.00"),
        ("20000", ".05", "мг", Basis(unit="мкг", per_tz_unit=10), "4000.00"),
        ("1.005", "1", "шт", Basis(unit="шт"), "1.01"),
    ],
)
def test_unit_normalization(price, amount, unit, basis, expected):
    assert normalize_price(offer(price=price, amount=amount, unit=unit), basis) == D(expected)


def test_unit_mismatch():
    with pytest.raises(UnitMismatch):
        normalize_price(offer(unit="мл"), Basis(unit="мкг"))


def test_delivery_is_separate_and_page_priority():
    source = offer(price="1000", delivery="separate", delivery_cost="300")
    assert normalize_price(source, Basis(unit="шт")) == D("1000.00")
    resolution = resolve_delivery(source, DeliveryPolicy(included=True, note="ЕИС"), D(1000), D(3))
    assert resolution.status == "added" and resolution.added_per_unit == D("100.00")
    # Включённая доставка и достигнутый порог страницы имеют приоритет над её стоимостью.
    assert (
        resolve_delivery(
            source.model_copy(update={"delivery": "included"}), DeliveryPolicy(), D(1000), D(3)
        ).status
        == "included"
    )
    source.delivery_free_from = D(3000)
    assert resolve_delivery(source, DeliveryPolicy(), D(1000), D(3)).status == "included"


def test_delivery_threshold_and_quantity():
    policy = DeliveryPolicy(free_from=D(5000), note="Условия источника")
    assert resolve_delivery(offer(), policy, D(100), D(50)).status == "included"
    assert resolve_delivery(offer(), policy, D(100), D(49)).status == "unknown"
    source = offer(delivery_free_from="5000")
    assert resolve_delivery(source, DeliveryPolicy(), D(100), D(50)).status == "included"
    assert resolve_delivery(source, DeliveryPolicy(), D(100), D(49)).status == "unknown"
    source = offer(delivery="separate", delivery_cost="500")
    assert resolve_delivery(source, DeliveryPolicy(), D(290), D(2500)).added_per_unit == D(".20")
    with pytest.raises(ValueError):
        resolve_delivery(source, DeliveryPolicy(), D(290), D(0))


@pytest.mark.parametrize(
    "status,expected", [("included", "included"), ("exempt", "exempt"), ("unknown", "unknown")]
)
def test_vat_neutral(status, expected):
    result = resolve_vat(offer(vat=status), "unknown", None, Rules())
    assert result.status == expected and result.factor == 1


def test_vat_rates_zero_and_final_price():
    source = offer(vat="excluded")
    assert resolve_vat(source, "unknown", None, Rules()).factor == D("1.22")
    source.vat_rate = D(".1")
    assert resolve_vat(source, "unknown", None, Rules()).factor == D("1.1")
    source.vat_rate = D(0)
    assert resolve_vat(source, "unknown", None, Rules()).factor == 1
    result = resolve_vat(source, "included", "ЕИС", Rules(), price_final=True)
    assert result.status == "exempt" and result.factor == 1
    assert resolve_vat(offer(), "included", "Источник", Rules()).note == "Источник"


CPI = {"2026-05": D("100.5"), "2026-06": D("100.3"), "2026-07": D("100.2")}


def test_index_month_boundaries_and_summed_increments():
    result = index_price(date(2026, 4, 15), date(2026, 8, 10), CPI, Rules(index_after_months=3))
    assert result.factor == D("1.0100") and result.status == "applied"
    assert "2026-05 — 2026-07" in result.note
    # Переход года и дефляция.
    result = index_price(
        date(2025, 11, 1),
        date(2026, 2, 1),
        {"2025-12": D("99.5"), "2026-01": D("100.2")},
        Rules(index_after_months=1),
    )
    assert result.factor == D(".9970")


def test_index_missing_data_and_not_needed():
    old, calc = date(2026, 4, 15), date(2026, 8, 10)
    rules = Rules(index_after_months=3)
    partial = index_price(old, calc, {"2026-05": D("100.5")}, rules)
    assert partial.factor == D("1.0050") and "нет данных ИПЦ за: 2026-06, 2026-07" in partial.note
    assert index_price(old, calc, {}, rules).status == "no_data"
    assert index_price(old, calc, CPI, Rules()).status == "not_needed"
    assert index_price(None, calc, CPI, rules).status == "not_needed"
    assert index_price(old, calc, CPI, Rules(indexation_enabled=False)).status == "not_needed"


def test_adjusted_chain():
    assert adjusted_price(
        D(100),
        VatResolution(status="added", factor="1.22", note=""),
        IndexResolution(status="applied", factor="1.0100", note=""),
        DeliveryResolution(status="added", added_per_unit=".20", note=""),
    ) == D("123.42")


def test_supplier_identity():
    rules = Rules()
    assert (
        supplier_key(offer(supplier_inn="77-01234567", supplier="ООО «Ромашка»"), rules)
        == "7701234567"
    )
    assert supplier_key(offer(supplier='ООО "Ромашка"'), rules) == supplier_key(
        offer(supplier="ромашка ООО"), rules
    )
    assert supplier_key(offer(url="https://www.komus.ru/p/1"), rules) == "komus.ru"
    for host in ("ozon.ru", "www.ozon.ru", "seller.ozon.ru", "market.yandex.ru"):
        assert supplier_key(offer(url="https://" + host + "/1"), rules) is None
    assert supplier_key(offer(source_id="eis"), rules) is None


def test_supplier_latest_then_cheapest_then_id_without_mutation():
    a = entry(id="a", price="300", supplier_inn="77", price_date=date(2024, 1, 1))
    b = entry(id="b", price="320", supplier_inn="77", price_date=date(2025, 6, 1))
    c = entry(id="c", price="290", supplier_inn="78")
    original = [a.model_copy(deep=True), b.model_copy(deep=True), c.model_copy(deep=True)]
    assert pick_per_supplier([a, b, c], Rules()) == ([b, c], [(a, b)])
    assert [a, b, c] == original
    b.offer.price_date = a.offer.price_date
    b.normalized_price = D(300)
    assert pick_per_supplier([b, a], Rules()) == ([a], [(b, a)])
    for e in (a, b):
        e.offer.source_id = "eis"
        e.offer.supplier_inn = None
    assert pick_per_supplier([a, b], Rules()) == ([a, b], [])


def test_spread_diagnostics_do_not_modify_sample():
    entries = [entry(price="100", source_id="eis")] * 3 + [entry(price="150", source_id="web")] * 3
    hint = diagnose_spread(entries, Rules())[0]
    assert "ЕИС" in hint and "33 %" in hint and "3 против 3" in hint
    assert len(entries) == 6
    assert diagnose_spread([entry(price="100", source_id="eis"), entry(price="105")], Rules()) == []
    entries = [entry(price="100", vat="exempt")] * 2 + [entry(price="130")] * 2
    assert "без НДС" in diagnose_spread(entries, Rules())[0]


def test_full_fixed_chain_repeatable():
    def run():
        sources = [
            offer(
                id=str(i),
                price=price,
                amount="5",
                unit="пач",
                supplier_inn=str(i),
                vat="included",
                delivery="included",
            )
            for i, price in enumerate(["1450", "1500", "1400", "9000"])
        ]
        entries = []
        rules = Rules()
        for source in sources:
            base = normalize_price(source, Basis(unit="пачка"))
            vat = resolve_vat(source, "unknown", None, rules)
            idx = index_price(source.price_date, date(2026, 11, 14), {}, rules)
            delivery = resolve_delivery(source, DeliveryPolicy(), base, D(2500))
            entries.append(
                entry(
                    id=source.id,
                    price=adjusted_price(base, vat, idx, delivery),
                    supplier_inn=source.supplier_inn,
                )
            )
        kept, _ = pick_per_supplier(entries, rules)
        prices = [e.normalized_price for e in kept]
        dropped, _ = find_outliers(prices, rules)
        result = calculate(
            [p for i, p in enumerate(prices) if i not in dropped], rules, outlier_prices=prices
        )
        return result, money(result.unit_price * D(2500))

    result, total = run()
    assert result.unit_price == D("290.00") and total == D("725000.00")
    assert run() == (result, total)
