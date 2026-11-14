"""Проверка извлечённого LLM по тексту страницы: код, без сети и LLM.

LLM получает позицию ТЗ вместе со страницей и иногда переносит в предложение
требования ТЗ (модель, «CHO», чистоту) или принимает иностранную валюту за
рубли. Значения, которых нет на странице, не считаются данными предложения.
"""

import re
from decimal import Decimal, InvalidOperation

from app.pipeline.identity import tokens

# Число после буквы (А3, D600) — часть кода, а не количество; 65Г — количество.
_NUMBER = re.compile(r"(?<![^\W\d_])(?<![\d.,])\d+(?:[.,]\d+)?")
# Валюта у самой цены: «EUR 449.00», «$328.00», «￥600.00», «147 342 AMD».
_FOREIGN = re.compile(
    r"(?<![a-zа-яё])(?:eur|usd|amd|kzt|byn|cny|rmb|gbp|uah|jpy|chf|"
    r"драм\w*|тенге|юан\w*|долл\w*|евро)(?![a-zа-яё])|[€$¥￥£֏]",
    re.I,
)
_RUB = re.compile(r"₽|руб|rub|(?<![a-zа-яё])р(?![a-zа-яё])", re.I)


_POWER_UNIT = re.compile(r"(?<![a-zа-яё])(?:м|m|см|cm|мм|mm|дм|км|km)[2²3³]", re.I)
# «3D-принтер» — не число 3.
_DIMENSIONS = re.compile(r"(?<![\w.,])[23][dд](?![a-zа-яё])", re.I)


def _numbers(text: str) -> set[str]:
    result = set()
    for raw in _NUMBER.findall(_DIMENSIONS.sub(" ", _POWER_UNIT.sub(" ", text))):
        try:
            result.add(format(Decimal(raw.replace(",", ".")).normalize(), "f"))
        except InvalidOperation:
            pass
    return result


# Квадратные и кубические единицы (м2, см3) — не коды моделей.
_UNIT_POWER = re.compile(r"(?:m|cm|mm|дm|km)[23]")


def _mixed(word: str) -> bool:
    return (
        any(c.isdigit() for c in word)
        and any(c.isalpha() for c in word)
        and not _UNIT_POWER.fullmatch(word)
    )


class PageEvidence:
    def __init__(self, *texts: str):
        text = "\n".join(texts)
        words = tokens(text)
        # Склейки до 6 токенов: «600 x 600 x 600» равно «600х600х600».
        self.runs = {"".join(words[i:j]) for i in range(len(words)) for j in range(i + 1, i + 7)}
        self.numbers = _numbers(text)
        # Словоформы: «Китай» есть в «Китайская Народная Республика».
        self.prefixes = {w[:k] for w in words if w.isalpha() for k in range(4, len(w) + 1)}

    def has_codes(self, value: str) -> bool:
        """Коды моделей и артикулы (D600, Tween20) встречаются на странице."""
        return all(w in self.runs for w in tokens(value) if _mixed(w))

    def has(self, value: str) -> bool:
        if not self.has_codes(value):
            return False
        words = tokens(value)
        numbers = _numbers(value)
        if numbers:
            return numbers <= self.numbers
        long_words = [w for w in words if w.isalpha() and len(w) >= 3]
        found = sum(w in self.runs or w in self.prefixes for w in long_words)
        return 2 * found >= len(long_words)


def foreign_currency(price: str, page_text: str) -> bool:
    """Цена не в рублях: валюта в строке цены или рядом с этим числом на странице."""
    if _FOREIGN.search(price):
        return True
    if _RUB.search(price):
        return False
    integer = re.split(r"[.,]\d{1,2}\s*$", price.strip())[0]
    digits = re.sub(r"\D", "", integer)
    if not digits:
        return False
    pattern = re.compile(r"(?<!\d)" + r"[\s  ,']?".join(digits) + r"(?![\d])")
    foreign = False
    for match in pattern.finditer(page_text):
        before = page_text[max(0, match.start() - 8) : match.start()]
        after = page_text[match.end() : match.end() + 14]
        if _RUB.search(before + after):
            return False
        foreign = foreign or bool(_FOREIGN.search(before + after))
    return foreign


def _stems(text: str) -> set[str]:
    # Словоформы одного слова совпадают по началу: «алюминиевая» и «алюминий».
    return {w[:5] for w in tokens(text) if w.isalpha() and len(w) >= 3}


def explicit_conflict(required: str, offered: str | None, evidence: PageEvidence) -> bool:
    """Значение предложения есть в его данных и явно противоречит требованию.

    Не противоречие: значение не указано, описано словами там, где требуется
    число, или совпадает с требованием частично (одно значение из списка,
    граница диапазона: «0,05 мм» при «0,05-0,4», «PLA» при списке пластиков).
    """
    if not offered or not offered.strip() or not evidence.has(offered):
        return False
    required_numbers = _numbers(required)
    if required_numbers:
        offered_numbers = _numbers(offered)
        return bool(offered_numbers) and not required_numbers & offered_numbers
    offered_stems = _stems(offered)
    return bool(offered_stems) and not _stems(required) & offered_stems
