"""Разбор цен и совместимые единицы; фасовка задаётся amount + amount_unit."""

import re
from decimal import Decimal


class UnitMismatch(ValueError):
    pass


_ALIASES = {
    "мкг": ("мкг", "µg", "μg", "ug", "mcg"),
    "мг": ("мг", "mg"),
    "г": ("г", "гр", "g"),
    "кг": ("кг", "kg"),
    "мл": ("мл", "ml"),
    "л": ("л", "l"),
    "шт": ("шт", "штука", "штуки", "штук", "pcs", "ед", "единица"),
    "пачка": ("пачка", "пачки", "пачек", "пач"),
    "упаковка": ("упаковка", "упаковки", "упаковок", "упак", "уп"),
    "м²": ("м²", "м2"),
}
_CANONICAL = {alias: unit for unit, aliases in _ALIASES.items() for alias in aliases}
_DIMENSIONS = {
    "мкг": ("mass", Decimal(1)),
    "мг": ("mass", Decimal(1000)),
    "г": ("mass", Decimal(10**6)),
    "кг": ("mass", Decimal(10**9)),
    "мл": ("volume", Decimal(1)),
    "л": ("volume", Decimal(1000)),
}


def parse_price(s: str) -> Decimal:
    # Пробел допускается только как разделитель тысяч, не между ценой и фасовкой.
    match = re.search(r"[-+]?\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)*", s)
    if match is None:
        raise ValueError("Цена не найдена в тексте")
    number = re.sub(r"[ \u00a0\u202f]", "", match.group())
    if "." in number and "," in number:
        decimal_separator = max(number.rfind("."), number.rfind(","))
        number = (
            re.sub(r"[.,]", "", number[:decimal_separator]) + "." + number[decimal_separator + 1 :]
        )
    else:
        number = number.replace(",", ".")
    try:
        value = Decimal(number)
    except ArithmeticError as exc:
        raise ValueError("Некорректная цена") from exc
    if not value.is_finite() or value < 0:
        raise ValueError("Цена должна быть неотрицательным конечным числом")
    return value


def canonical_unit(u: str) -> str:
    normalized = u.casefold().strip().replace(".", "")
    if not normalized:
        raise UnitMismatch("Не указана единица измерения")
    return _CANONICAL.get(normalized, normalized)


def convert(amount: Decimal, from_unit: str, to_unit: str) -> Decimal:
    if not amount.is_finite() or amount < 0:
        raise ValueError("Количество должно быть неотрицательным конечным числом")
    source, target = canonical_unit(from_unit), canonical_unit(to_unit)
    if source == target:
        return amount
    if source in _DIMENSIONS and target in _DIMENSIONS:
        dimension, factor = _DIMENSIONS[source]
        other_dimension, other_factor = _DIMENSIONS[target]
        if dimension == other_dimension:
            return amount * factor / other_factor
    raise UnitMismatch(f"Нельзя перевести {from_unit} в {to_unit}")
