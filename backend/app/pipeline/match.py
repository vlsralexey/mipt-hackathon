"""LLM сравнивает признаки; решение, идентификаторы и дубли определяет код."""

import hashlib
from decimal import Decimal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import Field, StrictBool

from app.llm.client import LLM, LLMFormatError
from app.llm.prompts import MATCH_SYSTEM
from app.llm.structured import complete_model
from app.models import CharComparison, DomainModel, ExclusionReason, Offer, Position
from app.units import canonical_unit

# Query иногда определяет сам товар/контракт. Удалять его целиком нельзя:
# у ЕИС все контракты имеют одинаковый path, а у магазинов бывают варианты фасовки.
IDENTITY_PARAMS = {
    "reestrnumber",
    "contractsubjectid",
    "id",
    "product_id",
    "sku",
    "variant",
    "offerid",
}


def canonical_url(url: str) -> str:
    p = urlsplit(url)
    query = sorted((k.lower(), v) for k, v in parse_qsl(p.query) if k.lower() in IDENTITY_PARAMS)
    host = (p.hostname or "").casefold().removeprefix("www.")
    port = f":{p.port}" if p.port and p.port not in (80, 443) else ""
    return urlunsplit((p.scheme.lower(), host + port, p.path.rstrip("/"), urlencode(query), ""))


def _variant(offer: Offer):
    return (
        " ".join(offer.title.casefold().split()),
        offer.amount,
        canonical_unit(offer.amount_unit),
    )


def offer_id(url: str, title: str, amount: Decimal, amount_unit: str) -> str:
    import json

    identity = [
        canonical_url(url),
        " ".join(title.casefold().split()),
        format(amount.normalize(), "f"),
        canonical_unit(amount_unit),
    ]
    return hashlib.sha1(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()[:12]


def dedupe(offers: list[Offer]) -> tuple[list[Offer], list[Offer]]:
    unique, duplicates = [], []
    urls, values = set(), set()
    for offer in offers:
        variant = _variant(offer)
        seller = offer.supplier_inn or (offer.supplier or "").casefold()
        if not seller:
            seller = (
                canonical_url(offer.url)
                if offer.source_id == "eis"
                else (urlsplit(offer.url).hostname or "").casefold()
            )
        url_key = (canonical_url(offer.url), variant, seller)
        value_key = (offer.source_id, variant, offer.price, seller)
        if url_key in urls or value_key in values:
            duplicates.append(offer)
        else:
            unique.append(offer)
            urls.add(url_key)
            values.add(value_key)
    return unique, duplicates


class RawComparison(DomainModel):
    name: str
    offered: str | None
    ok: StrictBool | None


class Comparisons(DomainModel):
    comparison: list[RawComparison] = Field(default_factory=list)


async def compare(llm: LLM, position: Position, offer: Offer) -> list[CharComparison]:
    if not position.characteristics:
        return []
    raw = await complete_model(
        llm,
        MATCH_SYSTEM,
        {"position": position.model_dump(), "offer": offer.model_dump()},
        Comparisons,
        "comparison",
    )
    by_name = {c.name.casefold(): c for c in raw.comparison}
    if len(by_name) != len(raw.comparison):
        raise LLMFormatError("Модель вернула повторные характеристики")
    result = []
    for c in position.characteristics:
        found = by_name.get(c.name.casefold())
        ok = found.ok if found and found.offered else None
        if (
            found
            and found.offered
            and c.name.casefold() in {"товарный знак", "торговая марка", "производитель", "модель"}
            and " ".join(found.offered.casefold().split()) == " ".join(c.value.casefold().split())
        ):
            # Регистр не делает SvetoCopy и Svetocopy разными марками.
            # Это только текстовое тождество, не угадывание аналогов/диапазонов.
            ok = True
        result.append(
            CharComparison(
                name=c.name,
                required=c.value,
                essential=c.essential,
                offered=found.offered if found else None,
                ok=ok,
            )
        )
    return result


def decide(comparison: list[CharComparison]) -> tuple[ExclusionReason | None, str]:
    essential = [c for c in comparison if c.essential]
    wrong = [c.name for c in essential if c.ok is False]
    if wrong:
        return "incomparable", "Не соответствует: " + ", ".join(wrong)
    confirmed = [c.name for c in essential if c.ok is True]
    if not confirmed:
        return "insufficient_data", "Недостаточно данных о существенных характеристиках"
    return None, "Совпадают: " + ", ".join(confirmed)
