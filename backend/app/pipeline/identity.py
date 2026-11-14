"""Тождество товара: марку и модель из ТЗ сверяет код по токенам.

LLM извлекает значения предложения и сравнивает их; решение «та же модель»
принимает код. Другая модель того же производителя — противоречие; марка без
модели не подтверждает модель. Написание не важно: регистр, пробелы, дефисы и
похожие кириллические/латинские буквы приводятся к одному виду.
"""

import re

from app.models import CharComparison, Offer, Position

TRADEMARK_NAMES = {"товарный знак", "торговая марка", "марка", "бренд"}
MAKER_NAMES = {"производитель"}
BRAND_NAMES = TRADEMARK_NAMES | MAKER_NAMES
MODEL_NAMES = {"модель", "модификация", "артикул", "каталожный номер"}
IDENTITY_NAMES = BRAND_NAMES | MODEL_NAMES

# Кириллические буквы, неотличимые от латинских в названиях моделей и марок.
_LOOKALIKE = str.maketrans("авеёкмнорстухі", "abeekmhopctyxi")
_WORD = re.compile(r"[0-9a-zа-я]+")
_LABEL = re.compile(
    r"(товарный знак|торговая марка|марка|бренд|производитель|модель|артикул)\s*:\s*([^.;,()]+)",
    re.I,
)
_SEGMENT_END = re.compile(r"[.;,:()\[\]]")


def missing_value(value: str) -> bool:
    return value.strip().casefold() in ("отсутствует", "не указан", "не указано", "нет")


def _norm(text: str) -> str:
    return (
        text.casefold().replace("ё", "е").replace("²", "2").replace("³", "3").translate(_LOOKALIKE)
    )


def tokens(text: str | None) -> list[str]:
    return _WORD.findall(_norm(text or ""))


# Слова, которые LLM переносит в значение модели из названия позиции.
_GENERIC = set(tokens("3D 3Д принтер printer модель model серия series мод"))
_COMPAT = set(tokens("для под замена for compatible"))
_COMPAT_STEMS = (_norm("совмест"), _norm("аналог"))
# Организационная форма не отличает производителя: «НПАО «Светогорский ЦБК»».
_LEGAL = set(tokens("ооо ао пао нпао зао оао ип ltd llc inc co gmbh corp"))


def _has_digit(token: str) -> bool:
    return any(ch.isdigit() for ch in token)


def _runs(words: list[str], longest: int) -> list[tuple[int, str]]:
    """Склейки соседних токенов: «D-600 Pro», «D600Pro» и «D 600 PRO» равны."""
    return [
        (start, "".join(words[start:end]))
        for start in range(len(words))
        for end in range(start + 1, min(len(words), start + longest) + 1)
    ]


def _find(core: list[str], text: str | None) -> int | None:
    """Позиция начала модели в тексте или None. Ищется вся модель целиком."""
    if not core:
        return None
    words = tokens(text)
    target = "".join(core)
    for start, joined in _runs(words, len(core) * 3):
        if joined == target:
            return start
    return None


def _confirmed(core: list[str], text: str | None) -> bool:
    start = _find(core, text)
    if start is None:
        return False
    # «Сопло для CreatBot D600 Pro» — принадлежность к модели, а не сама модель.
    before = tokens(text)[max(0, start - 3) : start]
    return not any(word in _COMPAT or word.startswith(_COMPAT_STEMS) for word in before)


def _labels(title: str, names: set[str]) -> list[str]:
    return [m[2].strip() for m in _LABEL.finditer(title) if m[1].casefold() in names]


def _brand_tokens(position: Position) -> set[str]:
    return {
        t
        for c in position.characteristics
        if c.name.casefold() in BRAND_NAMES
        for t in tokens(c.value)
    }


def _after_brand(title: str, brand: set[str]) -> list[str]:
    """Текст сразу за маркой в названии строки: «CreatBot PEEK 300» → PEEK 300."""
    result = []
    for segment in _SEGMENT_END.split(title):
        words = tokens(segment)
        for i, word in enumerate(words):
            if word in brand:
                result.append(" ".join(words[i + 1 : i + 4]))
    return result


def model_in_name(name: str, brand: str) -> str | None:
    """Модель из названия позиции: «3D принтер 3D CREATBOT D600 PRO» → «D600 PRO».

    Код модели начинается с буквы и содержит цифру; формат «А4» моделью не считается.
    """
    match = re.search(re.escape(brand.strip()), name, re.I)
    if not match or not brand.strip():
        return None
    segment = _SEGMENT_END.split(name[match.end() :])[0]
    words = segment.split()[:3]
    if not words or not words[0][0].isalpha() or not any(c.isdigit() for c in segment):
        return None
    if re.fullmatch(r"[aаAА][0-9]", words[0]):
        return None
    return " ".join(words)


def _data(offer: Offer) -> list[str]:
    """Данные предложения. Значение offered от LLM само по себе не доказательство:
    модель может скопировать требование ТЗ в ответ."""
    return [offer.title, *offer.characteristics.values()]


def _grounded(value: str | None, offer: Offer) -> bool:
    words = [t for t in tokens(value) if t not in _GENERIC]
    return bool(words) and any(_find(words, text) is not None for text in _data(offer))


def _model(row: CharComparison, offer: Offer, brand: set[str]) -> bool | None:
    core = [t for t in tokens(row.required) if t not in brand and t not in _GENERIC]
    if not core:
        return row.ok
    if row.ok is False:
        # Отличие только в написании не делает модель другой.
        offered = [t for t in tokens(row.offered) if t not in brand and t not in _GENERIC]
        same = "".join(offered) == "".join(core) and _grounded(row.offered, offer)
        return True if same else False
    if any(_confirmed(core, text) for text in _data(offer)):
        return True
    # Явно названная модель с другим кодом — другая модель того же производителя.
    declared = [
        v for k, v in offer.characteristics.items() if k.casefold() in IDENTITY_NAMES
    ] + _labels(offer.title, MODEL_NAMES)
    candidates = [row.offered, *declared, *_after_brand(offer.title, brand)]
    digits = {t for t in core if _has_digit(t)}
    for text in candidates:
        found = [t for t in tokens(text) if t not in brand and t not in _GENERIC]
        if any(_has_digit(t) and t not in digits for t in found):
            return False
    return None


# Слова названия юрлица, которые не отличают одного производителя от другого.
_MAKER_GENERIC = _LEGAL | set(
    tokens("завод комбинат компания группа фабрика холдинг корпорация концерн производство")
)
# «Производитель: Россия» называет страну, а не производителя.
_COUNTRY = tuple(
    tokens(
        "росси рф китай кнр германи сша япони коре тайван итали франци финлянд польш "
        "беларус белорус казахстан турци чехи швеци швейцари великобритан европ"
    )
)
_COUNTRY_FILLER = set(tokens("народная республика федерация страна производства"))


def _country(value: str) -> bool:
    words = tokens(value)
    return bool(words) and all(w in _COUNTRY_FILLER or w.startswith(_COUNTRY) for w in words)


def _same_stem(core: list[str], offer: Offer) -> bool:
    """Производитель назван иначе: «ПО Светогорск» при «Светогорский ЦБК».

    Ищется в названии и в поле производителя: торговая марка «Светогорск»
    производителя не подтверждает.
    """
    stems = {w[:7] for w in core if w.isalpha() and len(w) >= 6 and w not in _MAKER_GENERIC}
    texts = [offer.title] + [
        v for k, v in offer.characteristics.items() if k.casefold() in MAKER_NAMES
    ]
    words = {w for text in texts for w in tokens(text)}
    return any(w.startswith(stem) for stem in stems for w in words)


def _maker(row: CharComparison, offer: Offer) -> bool | None:
    """Производитель (юрлицо) не равен товарному знаку.

    Исключает только явно названный другой производитель. Отсутствие производителя
    или иное написание того же юрлица — ok=None, решение принимает decide.
    """
    core = [t for t in tokens(row.required) if t not in _LEGAL]
    if not core:
        return row.ok
    if any(_confirmed(core, text) for text in _data(offer)) or _same_stem(core, offer):
        return True
    if row.ok is True and _grounded(row.offered, offer):
        return True
    declared = [
        v for k, v in offer.characteristics.items() if k.casefold() in MAKER_NAMES
    ] + _labels(offer.title, MAKER_NAMES)
    named = [v for v in declared if not missing_value(v) and not _country(v)]
    offered = row.offered or ""
    if named or (
        row.ok is False
        and not missing_value(offered)
        and not _country(offered)
        and _grounded(offered, offer)
    ):
        return False
    return None


def _brand(row: CharComparison, offer: Offer) -> bool | None:
    if row.name.casefold() in MAKER_NAMES:
        return _maker(row, offer)
    core = tokens(row.required)
    if not core:
        return row.ok
    if any(_confirmed(core, text) for text in _data(offer)):
        # SVETOCOPY CLASSIC — та же марка, даже если LLM сочла иначе.
        return True
    if row.ok is True and _grounded(row.offered, offer):
        # Транслитерацию марки («Светокопи») сравнивает LLM; код её не угадывает.
        return True
    # Марку сравниваем с маркой, производителя — с производителем.
    declared = [
        v for k, v in offer.characteristics.items() if k.casefold() in TRADEMARK_NAMES
    ] + _labels(offer.title, TRADEMARK_NAMES)
    if row.ok is False or declared:
        # Названа другая марка («Отсутствует», «Светогорск»).
        return False
    return None


def verify_identity(
    position: Position, offer: Offer, comparison: list[CharComparison]
) -> list[CharComparison]:
    brand = _brand_tokens(position)
    result = []
    for row in comparison:
        name = row.name.casefold()
        if missing_value(row.required):
            pass
        elif name in MODEL_NAMES:
            row = row.model_copy(update={"ok": _model(row, offer, brand)})
        elif name in BRAND_NAMES:
            row = row.model_copy(update={"ok": _brand(row, offer)})
        result.append(row)
    return result


def model_confirmed(position: Position, comparison: list[CharComparison]) -> bool:
    """Модель из ТЗ подтверждена кодом (после verify_identity), а не только LLM."""
    brand = _brand_tokens(position)
    for row in comparison:
        if row.name.casefold() not in MODEL_NAMES or missing_value(row.required):
            continue
        core = [t for t in tokens(row.required) if t not in brand and t not in _GENERIC]
        # Без кода модели (только марка и общие слова) решение принимала LLM.
        if core and row.ok is True:
            return True
    return False
