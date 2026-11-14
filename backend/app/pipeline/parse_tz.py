"""ТЗ → позиции и вопросы с уже применёнными ответами по умолчанию."""

from collections import Counter

from pydantic import Field

from app.llm.client import LLM, LLMFormatError
from app.llm.prompts import ANSWER_SYSTEM, PARSE_TZ_SYSTEM
from app.llm.structured import complete_model
from app.models import DomainModel, ParsedTZ, Position, Question
from app.units import canonical_unit


class RawQuestion(DomainModel):
    position_index: int = Field(ge=1)
    text: str = Field(min_length=1)
    hint: str | None = None
    options: list[str] = Field(min_length=1)
    default_answer: str = Field(min_length=1)


class RawTZ(DomainModel):
    title: str = Field(min_length=1)
    positions: list[Position] = Field(min_length=1)
    questions: list[RawQuestion] = Field(default_factory=list)
    delivery_terms: str | None = None
    delivery_extras: list[str] = Field(default_factory=list)


def _units(position: Position, *, pack_basis: bool = False) -> Position:
    data = position.model_dump()
    data["unit"] = canonical_unit(position.unit)
    data["basis"]["unit"] = canonical_unit(position.basis.unit)
    if pack_basis and data["unit"] == "пачка":
        data["basis"] = {"unit": "пачка", "per_tz_unit": "1"}
    return Position.model_validate(data)


async def parse_tz(llm: LLM, tz_text: str) -> ParsedTZ:
    if not tz_text.strip():
        raise ValueError("ТЗ не содержит текста")
    raw = await complete_model(llm, PARSE_TZ_SYSTEM, {"tz_text": tz_text}, RawTZ, "parsed_tz")
    indices = [p.index for p in raw.positions]
    if indices != list(range(1, len(indices) + 1)):
        raise LLMFormatError("Позиции ТЗ должны иметь последовательные индексы с 1")
    questions = []
    counts = Counter()
    for q in raw.questions:
        if q.position_index not in indices or q.default_answer not in q.options:
            raise LLMFormatError("Некорректная позиция или ответ по умолчанию в вопросе")
        counts[q.position_index] += 1
        questions.append(
            Question(id=f"q{q.position_index}-{counts[q.position_index]}", **q.model_dump())
        )
    for position in raw.positions:
        brands = [
            c.value
            for c in position.characteristics
            if c.essential
            and c.name.casefold() in ("товарный знак", "производитель", "модель")
            and c.value.strip().casefold() not in ("отсутствует", "не указан")
        ]
        for brand in brands:
            if any(
                q.position_index == position.index
                and any(word in q.text.casefold() for word in ("аналог", "эквивалент"))
                for q in questions
            ):
                break
            counts[position.index] += 1
            default = f"Нет, только {brand}"
            questions.append(
                Question(
                    id=f"q{position.index}-{counts[position.index]}",
                    position_index=position.index,
                    text=f"Учитывать аналоги без марки {brand} с теми же характеристиками?",
                    options=[default, "Да, учитывать аналоги"],
                    default_answer=default,
                )
            )
    return ParsedTZ(
        title=raw.title,
        positions=[_units(p, pack_basis=True) for p in raw.positions],
        questions=questions,
        delivery_terms=raw.delivery_terms,
        delivery_extras=raw.delivery_extras,
    )


async def apply_answer(llm: LLM, position: Position, question: Question, answer: str) -> Position:
    if question.position_index != position.index or not answer.strip():
        raise ValueError("Ответ должен относиться к вопросу этой позиции и быть непустым")
    result = await complete_model(
        llm,
        ANSWER_SYSTEM,
        {"position": position.model_dump(), "question": question.model_dump(), "answer": answer},
        Position,
        "answered_position",
    )
    if result.index != position.index:
        raise LLMFormatError("Ответ модели изменил индекс позиции")
    return _units(result)
