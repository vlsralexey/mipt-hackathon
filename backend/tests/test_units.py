from decimal import Decimal as D

import pytest

from app.units import UnitMismatch, canonical_unit, convert, parse_price


@pytest.mark.parametrize(
    "text,expected",
    [
        ("1 290,50 ₽", "1290.50"),
        ("12\u00a0990 руб.", "12990"),
        ("1290.5", "1290.5"),
        ("от 3 450 ₽", "3450"),
        ("15\u202f000", "15000"),
        ("3 140,80333333333", "3140.80333333333"),
        ("100 ₽ за 25 мкг", "100"),
        ("1,290.50", "1290.50"),
        ("1.290,50", "1290.50"),
    ],
)
def test_parse_price(text, expected):
    assert parse_price(text) == D(expected)


@pytest.mark.parametrize("text", ["по запросу", "", "-100 ₽"])
def test_invalid_price(text):
    with pytest.raises(ValueError):
        parse_price(text)


@pytest.mark.parametrize(
    "amount,source,target,expected",
    [
        (".05", "мг", "мкг", "50"),
        ("25", "µg", "мкг", "25"),
        ("5", "Пачка.", "пачка", "5"),
        ("650", "пач", "пачка", "650"),
        ("1", "kg", "мкг", "1000000000"),
        ("1.5", "л", "мл", "1500"),
        ("1", "ед.", "шт.", "1"),
        ("2", "м2", "м²", "2"),
        ("3", "УСЛУГА.", "услуга", "3"),
    ],
)
def test_convert(amount, source, target, expected):
    assert convert(D(amount), source, target) == D(expected)


@pytest.mark.parametrize(
    "source,target", [("мл", "мкг"), ("шт", "пачка"), ("упаковка", "пачка"), ("", "шт")]
)
def test_incompatible(source, target):
    with pytest.raises(UnitMismatch):
        convert(D(1), source, target)


def test_canonical_unit():
    assert canonical_unit("  ПАЧ. ") == "пачка"
