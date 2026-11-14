from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import Field, ValidationError

from app.llm.client import LLM, LLMAuthError, LLMError
from app.llm.prompts import EXTRACT_SYSTEM
from app.llm.structured import complete_model
from app.models import DomainModel, Offer, Position
from app.pipeline.match import offer_id
from app.sources.base import CandidatePage, SourceAdapter
from app.units import canonical_unit, parse_price


class RawCharacteristic(DomainModel):
    name: str
    value: str


class RawOffer(DomainModel):
    title: str = Field(min_length=1)
    price: str | None
    amount: str | None
    amount_unit: str | None
    line_index: int | None = None
    vat: Literal["included", "excluded", "exempt", "unknown"] = "unknown"
    vat_rate: str | None = None
    supplier: str | None = None
    supplier_inn: str | None = None
    delivery: Literal["included", "separate", "unknown"] = "unknown"
    delivery_cost: str | None = None
    delivery_free_from: str | None = None
    delivery_note: str | None = None
    price_date: str | None = None
    characteristics: list[RawCharacteristic] = Field(default_factory=list)


class Extracted(DomainModel):
    offers: list[RawOffer] = Field(default_factory=list)


class ExtractFailure(DomainModel):
    page: CandidatePage
    reason: str


def _number(value: str | None) -> Decimal | None:
    if value is None:
        return None
    try:
        return parse_price(value)
    except ValueError:
        return None


def _rate(value: str | None) -> Decimal | None:
    rate = _number(value)
    if rate is not None and (rate > 1 or "%" in (value or "")):
        rate /= 100
    return rate if rate is not None and rate <= Decimal(".3") else None


def _date(value: str | None) -> date | None:
    if value:
        for fmt in ("%Y-%m-%d", "%d.%m.%Y"):
            try:
                return datetime.strptime(value, fmt).date()
            except ValueError:
                pass
    return None


async def extract_offers(
    llm: LLM, position: Position, page: CandidatePage, source: SourceAdapter
) -> tuple[list[Offer], list[ExtractFailure]]:
    try:
        raw = await complete_model(
            llm,
            EXTRACT_SYSTEM,
            {"position": position.model_dump(), "page": page.model_dump()},
            Extracted,
            "offers",
        )
    except LLMAuthError:
        raise
    except LLMError as exc:
        return [], [ExtractFailure(page=page, reason=str(exc))]
    offers, failures = [], []
    for row in raw.offers:
        price, amount = _number(row.price), _number(row.amount)
        title = row.title
        characteristics = {c.name: c.value for c in row.characteristics}
        unit = row.amount_unit
        vat, vat_rate = row.vat, _rate(row.vat_rate)
        if page.eis_lines:
            line = next((line for line in page.eis_lines if line.index == row.line_index), None)
            if line is None:
                failures.append(
                    ExtractFailure(page=page, reason="Не указан номер строки объекта закупки ЕИС")
                )
                continue
            price, vat, vat_rate = line.price, line.vat, line.vat_rate
            title = line.title.split("Страна происхождения")[0].strip()
            if line.characteristics:
                characteristics = line.characteristics
            # Для массы внутри штуки фасовку по описанию по-прежнему извлекает LLM.
            # Если единица цены совпадает с базой или единицей LLM — это цена за 1,
            # а не за весь объём контракта (650, 1000 и т.п.).
            if canonical_unit(line.amount_unit) in {
                canonical_unit(position.basis.unit),
                canonical_unit(unit or line.amount_unit),
            }:
                amount, unit = Decimal(1), line.amount_unit
        if price is None or price <= 0:
            failures.append(
                ExtractFailure(page=page, reason=f"{row.title}: цена не указана или не распознана")
            )
            continue
        if amount is None or amount <= 0 or not unit:
            failures.append(
                ExtractFailure(
                    page=page, reason=f"{row.title}: не распознаны фасовка или единица цены"
                )
            )
            continue
        unit = canonical_unit(unit)
        delivery_cost, free_from = _number(row.delivery_cost), _number(row.delivery_free_from)
        delivery = row.delivery
        if delivery == "separate" and delivery_cost is None:
            delivery = "unknown"
        inn = (row.supplier_inn or "").strip()
        if not inn.isascii() or not inn.isdigit() or len(inn) not in (10, 12):
            inn = None
        try:
            offers.append(
                Offer(
                    id=offer_id(page.url, title, amount, unit),
                    source_id=source.id,
                    source_name=source.name,
                    level=source.level,
                    url=page.url,
                    retrieved_at=page.retrieved_at,
                    title=title,
                    price=price,
                    amount=amount,
                    amount_unit=unit,
                    vat=vat,
                    vat_rate=vat_rate,
                    supplier=row.supplier,
                    supplier_inn=inn,
                    delivery=delivery,
                    delivery_cost=delivery_cost,
                    delivery_free_from=free_from,
                    delivery_note=row.delivery_note,
                    price_date=_date(row.price_date),
                    characteristics=characteristics,
                )
            )
        except (ValidationError, ValueError):
            failures.append(
                ExtractFailure(page=page, reason=f"{row.title}: неверные данные предложения")
            )
    return offers, failures
