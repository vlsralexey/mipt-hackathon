"""ТЗ → позиции и вопросы с уже применёнными ответами по умолчанию."""

from collections import Counter

from pydantic import Field

from app.llm.client import LLM, LLMFormatError
from app.llm.prompts import ANSWER_SYSTEM, PARSE_TZ_SYSTEM
from app.llm.structured import complete_model
from app.models import DomainModel, ParsedTZ, Position, Question
from app.units import canonical_unit

BRAND_FIELDS = {"товарный знак", "производитель", "модель", "марка", "бренд"}


def asks_about_analogs(text: str) -> bool:
    return any(word in text.casefold() for word in ("аналог", "эквивалент"))


def same_question(left: Question, right: Question) -> bool:
    return left.position_index == right.position_index and (
        left.id == right.id or asks_about_analogs(left.text) and asks_about_analogs(right.text)
    )


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
        # Модель может сформулировать одно решение о замене марки несколько раз.
        if any(
            existing.position_index == q.position_index
            and (
                existing.text.strip().casefold() == q.text.strip().casefold()
                or asks_about_analogs(existing.text)
                and asks_about_analogs(q.text)
            )
            for existing in questions
        ):
            continue
        counts[q.position_index] += 1
        questions.append(
            Question(id=f"q{q.position_index}-{counts[q.position_index]}", **q.model_dump())
        )
    for position in raw.positions:
        brands = [
            c.value
            for c in position.characteristics
            if c.essential
            and c.name.casefold() in BRAND_FIELDS
            and c.value.strip().casefold() not in ("отсутствует", "не указан")
        ]
        for brand in brands:
            if any(
                q.position_index == position.index and asks_about_analogs(q.text) for q in questions
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
    positions = [_units(p, pack_basis=True) for p in raw.positions]
    for position in positions:
        if position.unit == "шт" and position.basis.unit in {"мкг", "мг", "г", "мл", "л"}:
            existing = [q for q in questions if q.position_index == position.index]
            if any(
                any(
                    word in q.text.casefold()
                    for word in ("единиц", "фасов", "массу", position.basis.unit)
                )
                for q in existing
            ):
                continue
            counts[position.index] += 1
            default = f"За одну единицу ТЗ: {position.basis.per_tz_unit:g} {position.basis.unit}"
            questions.append(
                Question(
                    id=f"q{position.index}-{counts[position.index]}",
                    position_index=position.index,
                    text="Какую массу или объём принять за одну единицу ТЗ при сравнении цен?",
                    hint="Фасовки поставщиков могут отличаться "
                    "от массы или объёма в одной штуке ТЗ.",
                    options=[default, "Уточнить фасовку одной единицы ТЗ"],
                    default_answer=default,
                )
            )
    return ParsedTZ(
        title=raw.title,
        positions=positions,
        questions=questions,
        delivery_terms=raw.delivery_terms,
        delivery_extras=raw.delivery_extras,
    )


def button_answer(position: Position, question: Question, answer: str) -> Position | None:
    """Известные варианты применяем без очередного сетевого запроса к модели."""
    if answer == question.default_answer:
        return position.model_copy(deep=True)
    if answer not in question.options or not asks_about_analogs(question.text):
        return None
    normalized = answer.strip().casefold()
    if not normalized.startswith(("да", "нет")):
        return None
    brands = [c for c in position.characteristics if c.name.casefold() in BRAND_FIELDS]
    if not brands:
        return None
    result = position.model_copy(deep=True)
    for characteristic in result.characteristics:
        if characteristic.name.casefold() in BRAND_FIELDS:
            characteristic.essential = normalized.startswith("нет")
    return result


async def apply_answer(llm: LLM, position: Position, question: Question, answer: str) -> Position:
    if question.position_index != position.index or not answer.strip():
        raise ValueError("Ответ должен относиться к вопросу этой позиции и быть непустым")
    direct = button_answer(position, question, answer)
    if direct is not None:
        return direct
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
