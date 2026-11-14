"""Тождество модели и марки проверяет код, а не только LLM."""

import pytest
from fakes import offer, paper_position

from app.models import CharComparison
from app.pipeline.match import decide, verify, verify_identity


def printer(model="D600 PRO", *, essential=True):
    return paper_position(
        name="3D принтер 3D CREATBOT D600 PRO",
        unit="шт",
        quantity="1",
        basis={"unit": "шт", "per_tz_unit": "1"},
        characteristics=[
            {"name": "Товарный знак", "value": "CreatBot", "essential": essential},
            {"name": "Модель", "value": model, "essential": essential},
            {"name": "Технология печати", "value": "FDM", "essential": True},
        ],
    )


def rows(position, *, brand=(None, None), model=(None, None), tech=("FDM", True)):
    values = [brand, model, tech]
    return [
        CharComparison(name=c.name, required=c.value, essential=c.essential, offered=v[0], ok=v[1])
        for c, v in zip(position.characteristics, values, strict=True)
    ]


def checked(title, *, model=(None, None), brand=(None, None), required="D600 PRO", **kw):
    position = printer(required)
    comparison = rows(position, brand=brand, model=model)
    result = verify_identity(position, offer(title=title, **kw), comparison)
    return {c.name: c.ok for c in result}


@pytest.mark.parametrize(
    "title",
    [
        "3D принтер CreatBot D600 Pro",
        "3D-принтер CREATBOT D600PRO",
        "Creatbot D-600 Pro, область печати 600x600x600",
        "3D принтер CreatBot D600 РRО",  # кириллические Р и О
    ],
)
def test_same_model_spelled_differently_is_confirmed_by_title(title):
    assert checked(title)["Модель"] is True


def test_model_with_brand_and_generic_words_in_tz_still_matches():
    assert checked("CreatBot D600 Pro", required="3D CREATBOT D600 PRO")["Модель"] is True


def test_other_model_of_same_brand_in_eis_title_is_contradiction():
    # Реальная строка ЕИС 1650108482024000005: LLM вернула offered=None для модели.
    assert checked("1. Принтер 3D. CreatBot PEEK 300")["Модель"] is False


def test_llm_cannot_accept_other_model_of_same_brand():
    result = checked("3D принтер CreatBot F430", model=("CreatBot F430", True))
    assert result["Модель"] is False


def test_brand_without_model_is_not_confirmation():
    # Реальные строки ЕИС 1280102829824000034 и 1781204352224000023.
    assert checked("1. Принтер 3D. CreatBot")["Модель"] is None
    assert checked("1. Принтер 3D. CreatBot", model=("CreatBot", True))["Модель"] is None


def test_shorter_model_name_is_not_confirmed():
    assert checked("3D принтер CreatBot D600", model=("D600", True))["Модель"] is None
    assert checked("3D принтер CreatBot D600", model=("D600", False))["Модель"] is False


def test_accessory_for_model_is_not_the_model():
    assert checked("Сопло 0,4 мм для CreatBot D600 Pro")["Модель"] is None


def test_llm_spelling_false_negative_for_model_is_corrected():
    title = "Принтер CREATBOT D-600 PRO"
    assert checked(title, model=("CREATBOT D-600 PRO", False))["Модель"] is True


def test_model_copied_by_llm_from_tz_is_not_evidence():
    # docs/examples/printer.json, ЕИС 1781204352224000023: модели в строке нет.
    result = checked(
        "6. 3Д принтер. CreatBot",
        model=("3D CREATBOT D600 PRO", True),
        characteristics={"Товарный знак": "CreatBot"},
    )
    assert result["Модель"] is None


def test_model_from_offer_characteristics():
    result = checked("3D принтер", characteristics={"Модель": "D600 Pro"})
    assert result["Модель"] is True


@pytest.mark.parametrize(
    "title, llm, expected",
    [
        ("1. Бумага для офисной техники. Товарный знак: Svetocopy", (None, None), True),
        ("1. Бумага для офисной техники. Товарный знак: SVETOCOPY", (None, None), True),
        ("Бумага для офисной техники А3 SvetoCopy", (None, None), True),
        ("3. Бумага для офисной техники. Товарный знак: Отсутствует", (None, None), False),
        ("Бумага офисная Светокопи", ("Светокопи", True), True),
        ("Бумага офисная", ("SvetoCopy", True), None),
        ("Бумага А3 500 л.", ("Светогорск", False), False),
        ("Бумага офисная SVETOCOPY CLASSIC", ("SVETOCOPY CLASSIC", False), True),
        ("Бумага офисная", (None, None), None),
    ],
)
def test_brand(title, llm, expected):
    position = paper_position(
        characteristics=[{"name": "Товарный знак", "value": "SvetoCopy", "essential": True}]
    )
    comparison = [
        CharComparison(
            name="Товарный знак", required="SvetoCopy", essential=True, offered=llm[0], ok=llm[1]
        )
    ]
    assert verify_identity(position, offer(title=title), comparison)[0].ok is expected


def test_verify_identity_is_idempotent():
    position = printer()
    once = verify_identity(position, offer(title="CreatBot PEEK 300"), rows(position))
    assert verify_identity(position, offer(title="CreatBot PEEK 300"), once) == once


def test_unconfirmed_essential_model_is_insufficient_even_if_brand_matches():
    position = printer()
    comparison = rows(position, brand=("CreatBot", True))
    reason, text = decide(comparison)
    assert reason == "insufficient_data" and "Модель" in text


def test_model_is_not_required_when_analogs_are_allowed():
    position = printer(essential=False)
    comparison = rows(position, brand=("CreatBot", True))
    assert decide(comparison)[0] is None


def test_missing_required_value_is_not_checked_by_code():
    position = paper_position(
        characteristics=[{"name": "Товарный знак", "value": "Отсутствует", "essential": False}]
    )
    row = CharComparison(name="Товарный знак", required="Отсутствует", essential=False)
    assert verify_identity(position, offer(title="Бумага SvetoCopy"), [row])[0].ok is None


@pytest.mark.parametrize(
    "characteristics, expected",
    [
        # linerirk.ru из рабочего прогона бумаги: торговая марка не равна производителю.
        ({"Торговая марка": "Светогорск"}, None),
        ({"Производитель": "АО Светогорский ЦБК"}, True),
        ({"Производитель": "Монди СЛПК"}, False),
    ],
)
def test_manufacturer_is_compared_with_manufacturer_without_legal_form(characteristics, expected):
    position = paper_position(
        characteristics=[
            {"name": "Производитель", "value": "НПАО «Светогорский ЦБК»", "essential": True}
        ]
    )
    row = CharComparison(name="Производитель", required="НПАО «Светогорский ЦБК»", essential=True)
    result = verify_identity(
        position, offer(title="Бумага А3 SvetoCopy", characteristics=characteristics), [row]
    )
    assert result[0].ok is expected


def full_printer():
    return paper_position(
        name="3D принтер 3D CREATBOT D600 PRO",
        unit="шт",
        quantity="1",
        basis={"unit": "шт", "per_tz_unit": "1"},
        characteristics=[
            {"name": "Товарный знак", "value": "CreatBot", "essential": True},
            {"name": "Модель", "value": "D600 PRO", "essential": True},
            {"name": "Толщина слоя", "value": "0,05-0,4", "essential": True},
            {"name": "Диаметр нити", "value": "1,75", "essential": True},
            {"name": "Точность позиционирования X/Y", "value": "5.08", "essential": True},
            {"name": "Поддерживаемые пластики", "value": "PLA, ABS, PETG", "essential": True},
        ],
    )


def decided(title, characteristics, llm):
    """llm: {характеристика: (offered, ok)} — ответ LLM до проверки кодом."""
    position = full_printer()
    comparison = [
        CharComparison(
            name=c.name,
            required=c.value,
            essential=c.essential,
            offered=llm.get(c.name, (None, None))[0],
            ok=llm.get(c.name, (None, None))[1],
        )
        for c in position.characteristics
    ]
    return decide(verify(position, offer(title=title, characteristics=characteristics), comparison))


def test_same_model_with_unstated_or_differently_described_values_is_included():
    # creatbot3d.ru из живого прогона: LLM ставила ok=false по придиркам.
    exclusion, reason = decided(
        "3D принтер CreatBot D600 Pro",
        {
            "Толщина слоя": "0,05 мм",
            "Поддерживаемые пластики": "PLA, ABS, ASA, PETG, PC, нейлон",
            "Точность": "Высокоточные серводвигатели",
        },
        {
            "Модель": ("D600 Pro", True),
            "Толщина слоя": ("0,05 мм", False),
            "Поддерживаемые пластики": ("PLA, ABS, ASA, PETG, PC, нейлон", False),
            "Точность позиционирования X/Y": ("Высокоточные серводвигатели", False),
            "Диаметр нити": ("не указано", False),
        },
    )
    assert exclusion is None
    assert "проверьте: Толщина слоя" in reason


def test_same_model_with_explicit_contradiction_on_page_is_excluded():
    # ek.ua: в данных предложения диаметр нити 3 мм при требовании 1,75.
    exclusion, reason = decided(
        "3D принтер CreatBot D600 Pro",
        {"Диаметр нити": "3 мм"},
        {"Модель": ("D600 Pro", True), "Диаметр нити": ("3 мм", False)},
    )
    assert exclusion == "incomparable"
    assert reason == "Не соответствует: Диаметр нити"


def test_contradiction_not_present_in_offer_data_does_not_exclude_same_model():
    # LLM придумала значение, которого нет в предложении.
    exclusion, _ = decided(
        "3D принтер CreatBot D600 Pro",
        {},
        {"Модель": ("D600 Pro", True), "Диаметр нити": ("3 мм", False)},
    )
    assert exclusion is None


def test_other_model_of_same_brand_is_still_excluded():
    exclusion, reason = decided(
        "1. Принтер 3D. CreatBot PEEK 300",
        {},
        {"Товарный знак": ("CreatBot", True), "Модель": ("PEEK 300", False)},
    )
    assert exclusion == "incomparable"
    assert "Модель" in reason


def test_without_code_confirmed_model_llm_contradictions_still_exclude():
    # Модель названа только LLM (в строке её нет) — правило не применяется.
    exclusion, _ = decided(
        "1. 3D-принтер FDM. CreatBot",
        {},
        {"Модель": ("D600 PRO", True), "Толщина слоя": ("0,05 мм", False)},
    )
    assert exclusion == "incomparable"


def test_verify_is_idempotent_for_softened_rows():
    position = full_printer()
    item = offer(title="CreatBot D600 Pro", characteristics={"Толщина слоя": "0,05 мм"})
    comparison = [
        CharComparison(name=c.name, required=c.value, essential=c.essential)
        for c in position.characteristics
    ]
    comparison[1] = comparison[1].model_copy(update={"offered": "D600 Pro", "ok": True})
    comparison[2] = comparison[2].model_copy(update={"offered": "0,05 мм", "ok": False})
    once = verify(position, item, comparison)
    assert once[2].ok is None
    assert verify(position, item, once) == once


def svetocopy(*, trademark=True):
    characteristics = [
        {"name": "Производитель", "value": "НПАО Светогорский ЦБК", "essential": True},
        {"name": "Формат бумаги", "value": "А4", "essential": True},
    ]
    if trademark:
        characteristics.insert(
            0, {"name": "Товарный знак", "value": "SvetoCopy", "essential": True}
        )
    return paper_position(characteristics=characteristics)


def paper_decided(title, characteristics, maker, *, trademark=True):
    """maker: (offered, ok) производителя от LLM; товарный знак и формат LLM подтвердила."""
    position = svetocopy(trademark=trademark)
    llm = {"Товарный знак": ("SvetoCopy", True), "Формат бумаги": ("А4", True)}
    llm["Производитель"] = maker
    comparison = [
        CharComparison(
            name=c.name,
            required=c.value,
            essential=c.essential,
            offered=llm[c.name][0],
            ok=llm[c.name][1],
        )
        for c in position.characteristics
    ]
    return decide(verify(position, offer(title=title, characteristics=characteristics), comparison))


@pytest.mark.parametrize(
    "title, characteristics, maker",
    [
        # Контракт ЕИС 2332810135826000059: товарный знак есть, производителя нет.
        ("1. Бумага для офисной техники. Товарный знак: SVETOCOPY", {"Формат": "А4"}, (None, None)),
        # LLM сочла отсутствие производителя несоответствием.
        ("Бумага SVETOCOPY CLASSIC А4", {}, ("не указан", False)),
        # Страна в поле производителя — не другой производитель.
        ("Бумага SVETOCOPY CLASSIC А4", {"Производитель": "Россия"}, ("Россия", False)),
    ],
)
def test_unconfirmed_maker_with_confirmed_trademark_is_checked_not_excluded(
    title, characteristics, maker
):
    exclusion, reason = paper_decided(title, characteristics, maker)
    assert exclusion is None
    assert "проверьте: Производитель" in reason


def test_maker_spelled_differently_in_title_is_confirmed():
    exclusion, reason = paper_decided(
        "Бумага офисная SVETOCOPY А4 80г/м2 Светогорск", {}, (None, None)
    )
    assert exclusion is None and "Производитель" in reason.split(";")[0]


def test_explicitly_named_other_maker_is_excluded():
    exclusion, reason = paper_decided(
        "Бумага SvetoCopy А4",
        {"Производитель": "International Paper"},
        ("International Paper", False),
    )
    assert exclusion == "incomparable" and "Производитель" in reason


def test_maker_without_trademark_still_has_to_be_confirmed():
    # Без товарного знака производитель — единственное тождество товара.
    exclusion, reason = paper_decided("Бумага офисная А4", {}, (None, None), trademark=False)
    assert exclusion == "insufficient_data" and "Производитель" in reason
