"""LLM сравнивает признаки; решение, идентификаторы и дубли определяет код."""

import hashlib
from decimal import Decimal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import Field, StrictBool

from app.llm.client import LLM, LLMFormatError
from app.llm.prompts import MATCH_SYSTEM
from app.llm.structured import complete_model
from app.models import CharComparison, DomainModel, ExclusionReason, Offer, Position
from app.pipeline.grounding import PageEvidence, explicit_conflict
from app.pipeline.identity import (
    IDENTITY_NAMES,
    MAKER_NAMES,
    TRADEMARK_NAMES,
    missing_value,
    model_confirmed,
    verify_identity,
)
from app.units import canonical_unit

__all__ = ["compare", "decide", "dedupe", "offer_id", "verify", "verify_identity"]

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
        result.append(
            CharComparison(
                name=c.name,
                required=c.value,
                essential=c.essential,
                offered=found.offered if found else None,
                ok=found.ok if found and found.offered else None,
            )
        )
    return verify(position, offer, result)


def verify(
    position: Position, offer: Offer, comparison: list[CharComparison]
) -> list[CharComparison]:
    """Кодовая проверка сравнения LLM. Применяется и к сохранённым сравнениям.

    Регистр, пробелы и другая модель того же производителя проверяются кодом.
    Если код подтвердил ту же модель, предложение исключается только при явном
    противоречии: значение есть в данных предложения и не совпадает с
    требованием. «Не указано» и «описано иначе» становятся ok=None.
    """
    comparison = verify_identity(position, offer, comparison)
    if not model_confirmed(position, comparison):
        return comparison
    evidence = PageEvidence(offer.title, *offer.characteristics.values())
    result = []
    for row in comparison:
        if (
            row.ok is False
            and row.name.casefold() not in IDENTITY_NAMES
            and (
                missing_value(row.offered or "")
                or not explicit_conflict(row.required, row.offered, evidence)
            )
        ):
            row = row.model_copy(update={"ok": None})
        result.append(row)
    return result


def decide(comparison: list[CharComparison]) -> tuple[ExclusionReason | None, str]:
    essential = [c for c in comparison if c.essential]
    wrong = [c.name for c in essential if c.ok is False]
    if wrong:
        return "incomparable", "Не соответствует: " + ", ".join(wrong)
    # Производитель — юрлицо, а не товарный знак. При подтверждённом товарном знаке
    # (модель проверяется отдельно) его отсутствие или иное написание не исключает.
    branded = any(c.ok is True and c.name.casefold() in TRADEMARK_NAMES for c in essential)
    maker_unknown = [c.name for c in essential if c.ok is None and c.name.casefold() in MAKER_NAMES]
    # Модель или марка из ТЗ без подтверждения — возможно, другой товар того же ряда.
    unknown = [
        c.name
        for c in essential
        if c.ok is None
        and c.name.casefold() in IDENTITY_NAMES
        and not (branded and c.name in maker_unknown)
    ]
    if unknown:
        return "insufficient_data", "Не подтверждены: " + ", ".join(unknown)
    confirmed = [c.name for c in essential if c.ok is True]
    if not confirmed:
        return "insufficient_data", "Недостаточно данных о существенных характеристиках"
    reason = "Совпадают: " + ", ".join(confirmed)
    # Значение названо, но сравнить с требованием нельзя: стоит проверить вручную.
    unclear = [
        c.name
        for c in essential
        if c.ok is None and (c.offered and c.offered.strip() or c.name in maker_unknown)
    ]
    if unclear:
        reason += "; проверьте: " + ", ".join(unclear)
    return None, reason
