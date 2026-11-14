import pytest
from fakes import D, FakeLLM, paper_position

from app.llm.client import LLMFormatError
from app.pipeline.parse_tz import apply_answer, parse_tz


def raw_tz(**overrides):
    return dict(title="Бумага", positions=[paper_position().model_dump(mode="json")]) | overrides


def question(**overrides):
    return (
        dict(
            position_index=1,
            text="Учитывать аналоги?",
            options=["Нет, только SvetoCopy", "Да"],
            default_answer="Нет, только SvetoCopy",
        )
        | overrides
    )


async def test_parse_builds_positions_and_stable_questions():
    llm = FakeLLM([raw_tz(questions=[question(), question(text="Другой вопрос")])])
    result = await parse_tz(llm, "Таблица ТЗ")
    assert result.positions[0].quantity == D(2500)
    assert result.positions[0].basis.unit == "пачка"
    assert result.positions[0].search_terms
    assert [q.id for q in result.questions] == ["q1-1", "q1-2"]
    assert result.questions[0].answer is None
    assert "Таблица ТЗ" in llm.calls[0][2]


@pytest.mark.parametrize(
    "data",
    [
        raw_tz(questions=[question(position_index=2)]),
        raw_tz(questions=[question(default_answer="нет варианта")]),
        raw_tz(positions=[paper_position(index=2).model_dump(mode="json")]),
        raw_tz(positions=[]),
    ],
)
async def test_parse_rejects_invalid_links_and_defaults(data):
    with pytest.raises(LLMFormatError):
        await parse_tz(FakeLLM([data]), "ТЗ")


async def test_answer_normalizes_units_and_preserves_position_identity():
    parsed = await parse_tz(FakeLLM([raw_tz(questions=[question()])]), "ТЗ")
    pos = parsed.positions[0]
    changed = pos.model_dump(mode="json") | {"unit": "пач."}
    result = await apply_answer(FakeLLM([changed]), pos, parsed.questions[0], "Да")
    assert result.unit == "пачка"
    assert pos == parsed.positions[0]
    with pytest.raises(LLMFormatError):
        await apply_answer(FakeLLM([changed | {"index": 2}]), pos, parsed.questions[0], "Да")


async def test_empty_input_does_not_call_llm():
    llm = FakeLLM()
    with pytest.raises(ValueError):
        await parse_tz(llm, " ")
    assert not llm.calls


async def test_paper_pack_is_not_mistaken_for_500_sheets():
    pos = paper_position(basis={"unit": "лист", "per_tz_unit": "500"})
    parsed = await parse_tz(FakeLLM([raw_tz(positions=[pos.model_dump(mode="json")])]), "ТЗ")
    assert parsed.positions[0].basis.unit == "пачка"
    assert parsed.positions[0].basis.per_tz_unit == D(1)


async def test_missing_brand_question_is_added_without_weakening_requirement():
    pos = paper_position(
        characteristics=[{"name": "Товарный знак", "value": "SvetoCopy", "essential": True}]
    )
    parsed = await parse_tz(FakeLLM([raw_tz(positions=[pos.model_dump(mode="json")])]), "ТЗ")
    assert parsed.questions[0].default_answer == "Нет, только SvetoCopy"
    assert parsed.positions[0].characteristics[0].essential


async def test_repeated_sveto_copy_analog_questions_are_one_decision():
    pos = paper_position(
        characteristics=[{"name": "Товарный знак", "value": "SvetoCopy", "essential": True}]
    )
    parsed = await parse_tz(
        FakeLLM(
            [
                raw_tz(
                    positions=[pos.model_dump(mode="json")],
                    questions=[
                        question(text="Допускается ли замена бумаги SvetoCopy на аналоги?"),
                        question(text="Учитывать эквиваленты SvetoCopy?"),
                        question(text="Какая фасовка?"),
                    ],
                )
            ]
        ),
        "ТЗ",
    )
    assert [q.id for q in parsed.questions] == ["q1-1", "q1-2"]
    assert parsed.questions[1].text == "Какая фасовка?"
    llm = FakeLLM()
    result = await apply_answer(llm, pos, parsed.questions[0], "Да")
    assert not result.characteristics[0].essential and not llm.calls


async def test_default_no_analogs_makes_brand_and_model_essential():
    """Ответ по умолчанию «только марка» уже отражён в позиции, как обещает вопрос."""
    pos = paper_position(
        characteristics=[
            {"name": "Товарный знак", "value": "CreatBot", "essential": True},
            {"name": "Модель", "value": "D600 PRO", "essential": False},
            {"name": "Цвет", "value": "белый", "essential": False},
            {"name": "Производитель", "value": "не указан", "essential": False},
        ]
    )
    q = question(options=["Нет, только CreatBot", "Да"], default_answer="Нет, только CreatBot")
    parsed = await parse_tz(
        FakeLLM([raw_tz(positions=[pos.model_dump(mode="json")], questions=[q])]), "ТЗ"
    )
    flags = [c.essential for c in parsed.positions[0].characteristics]
    assert flags == [True, True, False, False]


@pytest.mark.parametrize(
    "name, model",
    [
        # Живой прогон 14.11.2026: LLM не выделила модель, и PEEK 300 попал в расчёт.
        ("3D принтер 3D CREATBOT D600 PRO", "D600 PRO"),
        ("Принтер CreatBot F430, белый", "F430"),
        ("Бумага CreatBot А4", None),
        ("Бумага для офисной техники CreatBot", None),
    ],
)
async def test_model_from_position_name_is_kept_as_requirement(name, model):
    pos = paper_position(
        name=name,
        characteristics=[{"name": "Товарный знак", "value": "CreatBot", "essential": True}],
    )
    parsed = await parse_tz(FakeLLM([raw_tz(positions=[pos.model_dump(mode="json")])]), "ТЗ")
    found = {c.name: c for c in parsed.positions[0].characteristics}
    if model is None:
        assert "Модель" not in found
    else:
        assert found["Модель"].value == model and found["Модель"].essential


async def test_equivalent_allowed_by_default_keeps_model_optional():
    pos = paper_position(
        characteristics=[{"name": "Модель", "value": "D600 PRO", "essential": False}]
    )
    q = question(options=["Да, учитывать аналоги", "Нет"], default_answer="Да, учитывать аналоги")
    parsed = await parse_tz(
        FakeLLM([raw_tz(positions=[pos.model_dump(mode="json")], questions=[q])]), "ТЗ"
    )
    assert not parsed.positions[0].characteristics[0].essential


async def test_mass_inside_piece_has_question_even_if_model_omits_it():
    pos = paper_position(name="Реагент", unit="шт", basis={"unit": "мкг", "per_tz_unit": "10"})
    parsed = await parse_tz(FakeLLM([raw_tz(positions=[pos.model_dump(mode="json")])]), "ТЗ")
    assert len(parsed.questions) == 1
    assert "10 мкг" in parsed.questions[0].default_answer
    assert parsed.positions[0].basis.per_tz_unit == 10


async def test_standard_printer_analog_button_does_not_call_model():
    from app.models import Question

    pos = paper_position(
        characteristics=[
            {"name": "Модель", "value": "D600 PRO", "essential": True},
            {"name": "Высота печати", "value": "600", "unit": "мм", "essential": True},
        ]
    )
    q = Question(
        id="q1",
        position_index=1,
        text="Учитывать аналоги D600 PRO?",
        options=["Нет, только D600 PRO", "Да, учитывать аналоги"],
        default_answer="Нет, только D600 PRO",
    )
    llm = FakeLLM()
    result = await apply_answer(llm, pos, q, "Да, учитывать аналоги")
    assert not result.characteristics[0].essential
    assert result.characteristics[1].essential and pos.characteristics[0].essential
    assert not llm.calls
    default = await apply_answer(llm, pos, q, q.default_answer)
    assert default == pos and default is not pos and not llm.calls


def branded(brand="SvetoCopy"):
    return paper_position(
        characteristics=[{"name": "Товарный знак", "value": brand, "essential": True}]
    )


async def test_single_option_analog_question_gets_standard_analog_choice():
    # Так модель ответила на реальном ТЗ на бумагу: вопрос об аналогах без варианта «да».
    raw = raw_tz(
        positions=[branded().model_dump(mode="json")],
        questions=[
            question(
                text="Есть ли аналоги товару с торговой маркой SvetoCopy?",
                options=["Нет, только SvetoCopy"],
            )
        ],
    )
    parsed = await parse_tz(FakeLLM([raw]), "ТЗ")
    assert len(parsed.questions) == 1
    q = parsed.questions[0]
    assert q.options == ["Нет, только SvetoCopy", "Да, учитывать аналоги"]
    llm = FakeLLM()
    result = await apply_answer(llm, parsed.positions[0], q, "Да, учитывать аналоги")
    assert not result.characteristics[0].essential and not llm.calls


async def test_analog_question_without_brand_only_choice_gets_it():
    raw = raw_tz(
        positions=[branded().model_dump(mode="json")],
        questions=[
            question(
                text="Допускаются ли эквиваленты?",
                options=["Да, допускаются"],
                default_answer="Да, допускаются",
            )
        ],
    )
    parsed = await parse_tz(FakeLLM([raw]), "ТЗ")
    q = parsed.questions[0]
    assert q.options == ["Нет, только SvetoCopy", "Да, допускаются"]
    llm = FakeLLM()
    result = await apply_answer(llm, parsed.positions[0], q, "Нет, только SvetoCopy")
    assert result.characteristics[0].essential and not llm.calls


async def test_trademark_named_torgovaya_marka_is_treated_as_brand():
    pos = paper_position(
        characteristics=[{"name": "Торговая марка", "value": "SvetoCopy", "essential": True}]
    )
    parsed = await parse_tz(FakeLLM([raw_tz(positions=[pos.model_dump(mode="json")])]), "ТЗ")
    assert [q.default_answer for q in parsed.questions] == ["Нет, только SvetoCopy"]
    llm = FakeLLM()
    result = await apply_answer(llm, pos, parsed.questions[0], "Да, учитывать аналоги")
    assert not result.characteristics[0].essential and not llm.calls


def test_stored_single_option_analog_question_is_normalized_on_read():
    from app.models import Question

    q = Question.model_validate(
        {
            "id": "q1-1",
            "position_index": 1,
            "text": "Учитывать аналоги?",
            "options": ["Да"],
            "default_answer": "Да",
        }
    )
    assert len(q.options) == 2 and q.options[0].startswith("Нет, только")
    assert q.default_answer == "Да"


def test_option_that_merely_starts_with_da_is_not_analog_choice():
    from app.models import Question

    q = Question(
        id="q1-1",
        position_index=1,
        text="Учитывать аналоги?",
        options=["Нет, только SvetoCopy", "Данные уточнить позже"],
        default_answer="Нет, только SvetoCopy",
    )
    assert "Да, учитывать аналоги" in q.options


@pytest.mark.parametrize(
    ("answer", "choice"),
    [
        ("Нет, только SvetoCopy", "no"),
        ("Только SvetoCopy", "no"),
        ("только указанная марка", "no"),
        ("Без аналогов", "no"),
        ("Без замены на другую марку", "no"),
        ("Не допускаются", "no"),
        ("Да, учитывать аналоги", "yes"),
        ("Данные уточнить позже", None),
        ("Нетканая бумага", None),
    ],
)
def test_analog_choice_recognizes_brand_only_wording(answer, choice):
    from app.models import analog_choice

    assert analog_choice(answer) == choice


async def test_brand_only_option_without_net_is_not_duplicated():
    # Модель написала «Только SvetoCopy» без «Нет»: второй похожий вариант не нужен.
    raw = raw_tz(
        positions=[branded().model_dump(mode="json")],
        questions=[
            question(
                text="Учитывать аналоги SvetoCopy?",
                options=["Только SvetoCopy", "Да, учитывать аналоги"],
                default_answer="Да, учитывать аналоги",
            )
        ],
    )
    parsed = await parse_tz(FakeLLM([raw]), "ТЗ")
    q = parsed.questions[0]
    assert q.options == ["Только SvetoCopy", "Да, учитывать аналоги"]
    pos = parsed.positions[0].model_copy(deep=True)
    pos.characteristics[0].essential = False
    llm = FakeLLM()
    result = await apply_answer(llm, pos, q, "Только SvetoCopy")
    assert result.characteristics[0].essential and not llm.calls


def test_stored_brand_only_option_gets_only_yes_on_read():
    from app.models import Question

    q = Question.model_validate(
        {
            "id": "q1-1",
            "position_index": 1,
            "text": "Учитывать аналоги?",
            "options": ["Без аналогов"],
            "default_answer": "Без аналогов",
        }
    )
    assert q.options == ["Без аналогов", "Да, учитывать аналоги"]
