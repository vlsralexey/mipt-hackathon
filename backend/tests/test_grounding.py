"""Цена и характеристики сверяются с текстом страницы. Фрагменты — из живых прогонов."""

import pytest

from app.pipeline.grounding import PageEvidence, explicit_conflict, foreign_currency


@pytest.mark.parametrize(
    "price, text",
    [
        ("335", "SVETOCOPY\n335\n,\n00\nруб\nПри заказе"),  # diplomat.ooo
        ("181,00", "26 шт\n>10\n181\n,00\nР\n/шт"),  # helmi-opt.ru
        ("24000", "Цена:\n24 000 р.\nКат. №:"),  # sci-store.ru
        ("33573", "10 мкг\n33 573,=\nRUB\n33 573\nПод заказ"),  # dia-m.ru
        ("740", "В наличии\n740\n₽\nКоличество"),  # offt.ru
        ("290", "Цена 290"),  # валюта не указана — по умолчанию рубли
    ],
)
def test_rouble_prices_are_kept(price, text):
    assert not foreign_currency(price, text)


@pytest.mark.parametrize(
    "price, text",
    [
        ("EUR 449.00", "Unit Price:\nEUR 449.00\nLog in"),  # discoverx.com
        ("147 342", "10 мкг\n147 342\n147 342\nAMD\nPSG240-50"),  # star-lab.am
        ("328.00", "Price:\n$328.00\n$2,035.00"),  # eastmabbio.com
        ("600.00", "5 μg\n￥600.00\n现货"),  # chamot-bio.com
        ("1200.00", "10μg\n¥1,200.00"),
        ("60,00 €", "60,00 €"),
    ],
)
def test_foreign_prices_are_rejected(price, text):
    assert foreign_currency(price, text)


def test_tz_values_absent_on_page_are_not_evidence():
    page = PageEvidence(
        "Recombinant Human IL-21",
        "Size: 10 µg\nUnit Price: EUR 449.00\nStore at -20°C.",
    )
    assert not page.has("CHO")
    assert not page.has("более 98 %")
    assert not page.has("3D CREATBOT D600 PRO")
    assert page.has("10 µg")


def test_same_values_written_differently_are_evidence():
    page = PageEvidence("", "Область построения 600 x 600 x 600 мм; PBS, Tween 20, pH 7,0")
    assert page.has("600х600х600 мм")  # кириллическая «х»
    assert page.has("pH 7.0, Tween20")
    assert page.has_codes("Принтер (600x600x600)")
    assert not page.has_codes("3D принтер D600 (600x600x600)")


def test_units_and_word_forms_are_not_codes():
    # helmi-opt.ru: «65Г/М» на странице, LLM записала «65 г/м2».
    assert PageEvidence("", "ОФСЕТ А4 200Л 65Г/М").has("65 г/м2")
    assert PageEvidence("", "Плотность 80 г/м²").has("80 г/м2")
    # ЕИС: «Китайская Народная Республика», LLM записала «Китай».
    assert PageEvidence("", "Страна происхождения: Китайская Народная Республика").has("Китай")


def test_tz_tolerances_copied_into_offer_are_not_evidence():
    # offt.ru: на странице «80 г/м²», а «± 3» и толщина 104 — из ТЗ.
    page = PageEvidence("", "Бумага офисная А3, класс С, 146%, 80 г/м², 500 л., SvetoCopy")
    assert not page.has("104 ± 2 мкм")
    assert not page.has("80 ± 3 г/м2")
    assert not page.has("Р 57641-2017")


@pytest.mark.parametrize(
    "required, offered, page, expected",
    [
        ("1,75", "3 мм", "Диаметр нити: 3 мм", True),
        ("Закрытый", "Открытый", "Тип корпуса: открытый", True),
        ("0,05-0,4", "0,05 мм", "Толщина слоя 0,05 мм", False),  # граница диапазона
        ("PLA, ABS, PETG", "PLA", "Пластики: PLA", False),  # часть списка
        ("5.08", "Высокоточные серводвигатели", "Высокоточные серводвигатели", False),
        ("1,75", "3 мм", "3D принтер CreatBot D600 Pro", False),  # нет на странице
        ("1,75", None, "Диаметр нити: 3 мм", False),
    ],
)
def test_explicit_conflict_needs_contradicting_value_on_page(required, offered, page, expected):
    assert explicit_conflict(required, offered, PageEvidence(page)) is expected
