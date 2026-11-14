from datetime import UTC, datetime
from decimal import Decimal

from app.models import DeliveryResolution, IndexResolution, Offer, OfferEntry, VatResolution


def offer(**overrides):
    data = dict(
        id="o1",
        source_id="web",
        source_name="Магазин",
        level=1,
        url="https://example.org/product",
        retrieved_at=datetime(2026, 11, 14, tzinfo=UTC),
        title="Товар",
        price="100",
        amount="1",
        amount_unit="шт",
    )
    if "unit" in overrides:
        overrides["amount_unit"] = overrides.pop("unit")
    return Offer.model_validate(data | overrides)


def entry(*, vat="included", **overrides):
    source = offer(**overrides)
    return OfferEntry(
        offer=source,
        base_price=source.price,
        normalized_price=source.price,
        reason="Подходит",
        vat=VatResolution(status=vat, note="Тест"),
        indexation=IndexResolution(status="not_needed", note="Тест"),
        delivery=DeliveryResolution(status="included", note="Тест"),
    )


D = Decimal


class FakeLLM:
    def __init__(self, json_responses=None, chat_responses=None):
        self.json_responses = (
            json_responses if callable(json_responses) else iter(json_responses or [])
        )
        self.chat_responses = iter(chat_responses or [])
        self.calls = []

    async def complete_json(self, system, user, schema_name, schema):
        self.calls.append(("complete_json", system, user, schema_name, schema))
        if callable(self.json_responses):
            return self.json_responses(system, user, schema_name)
        return next(self.json_responses)

    async def chat(self, messages, tools):
        self.calls.append(("chat", messages, tools))
        return next(self.chat_responses)


def paper_position(**overrides):
    from app.models import Position

    return Position.model_validate(
        dict(
            index=1,
            name="Бумага SvetoCopy А4",
            unit="пачка",
            quantity="2500",
            basis={"unit": "пачка", "per_tz_unit": "1"},
            characteristics=[{"name": "Формат", "value": "А4", "essential": True}],
            search_terms=["SvetoCopy", "бумага для офисной техники"],
        )
        | overrides
    )
