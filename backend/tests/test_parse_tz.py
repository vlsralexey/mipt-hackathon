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
