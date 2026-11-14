"""Приведение единицы, НДС, индексация и доставка; без сети и текущего времени."""

import re
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, localcontext
from urllib.parse import urlsplit

from app.config import DeliveryPolicy, Rules
from app.models import Basis, DeliveryResolution, IndexResolution, Offer, OfferEntry, VatResolution
from app.pipeline.calc import money
from app.units import convert


def normalize_price(offer: Offer, basis: Basis) -> Decimal:
    with localcontext() as context:
        context.prec = 50
        amount = convert(offer.amount, offer.amount_unit, basis.unit)
        return money(offer.price / amount * basis.per_tz_unit)


def resolve_vat(
    offer: Offer,
    vat_default: str,
    vat_note: str | None,
    rules: Rules,
    price_final: bool = False,
) -> VatResolution:
    if offer.vat == "included":
        return VatResolution(status="included", note="НДС включён по данным страницы")
    if offer.vat == "exempt":
        return VatResolution(status="exempt", note="НДС не облагается — цена конечная")
    if offer.vat == "excluded" and price_final:
        return VatResolution(
            status="exempt", note="Цена контракта конечная; «Без НДС» — поставщик не платит НДС"
        )
    if offer.vat == "excluded":
        rate = offer.vat_rate if offer.vat_rate is not None else rules.vat_rate
        source = "со страницы" if offer.vat_rate is not None else "из настроек"
        return VatResolution(
            status="added", factor=1 + rate, note=f"Начислен НДС {rate * 100:g} %; ставка {source}"
        )
    if vat_default == "included":
        return VatResolution(status="included", note=vat_note or "Допущение источника: НДС включён")
    return VatResolution(status="unknown", note="НДС на странице не указан")


def resolve_delivery(
    offer: Offer,
    policy: DeliveryPolicy,
    unit_price: Decimal,
    quantity: Decimal,
) -> DeliveryResolution:
    if not quantity.is_finite() or quantity <= 0 or not unit_price.is_finite() or unit_price < 0:
        raise ValueError("Для доставки нужны положительное количество и неотрицательная цена")
    order_sum = unit_price * quantity
    page = offer.delivery_note or "по данным страницы"
    if offer.delivery == "included":
        return DeliveryResolution(status="included", note=f"Доставка включена: {page}")
    if offer.delivery_free_from is not None and order_sum >= offer.delivery_free_from:
        return DeliveryResolution(
            status="included",
            note=(
                f"Бесплатно от {offer.delivery_free_from:g} ₽ со страницы; "
                f"заказ по ТЗ {order_sum:g} ₽; {page}"
            ),
        )
    if offer.delivery == "separate" and offer.delivery_cost is not None:
        return DeliveryResolution(
            status="added",
            added_per_unit=money(offer.delivery_cost / quantity),
            note=f"Доставка {offer.delivery_cost:g} ₽ на весь объём ТЗ: {page}",
        )
    if policy.included:
        return DeliveryResolution(
            status="included", note=policy.note or "По условиям источника доставка включена"
        )
    if policy.free_from is not None and order_sum >= policy.free_from:
        return DeliveryResolution(
            status="included",
            note=(
                f"Бесплатно от {policy.free_from:g} ₽ по условиям источника; "
                f"заказ по ТЗ {order_sum:g} ₽; {policy.note or ''}"
            ),
        )
    return DeliveryResolution(
        status="unknown",
        note="Стоимость доставки не указана на странице"
        + (f"; {offer.delivery_note}" if offer.delivery_note else ""),
    )


def index_price(
    price_date: date | None,
    calc_date: date,
    cpi: dict[str, Decimal],
    rules: Rules,
) -> IndexResolution:
    if not rules.indexation_enabled:
        return IndexResolution(status="not_needed", note="Индексация отключена в правилах")
    if price_date is None:
        return IndexResolution(
            status="not_needed", note="Дата цены неизвестна; цена считается текущей"
        )
    age = (calc_date.year - price_date.year) * 12 + calc_date.month - price_date.month
    if age <= rules.index_after_months:
        return IndexResolution(
            status="not_needed", note=f"Цена не старше {rules.index_after_months} месяцев"
        )
    # Конвенция проекта: следующий месяц после цены … предыдущий перед расчётом.
    months = [
        f"{ordinal // 12:04d}-{ordinal % 12 + 1:02d}"
        for ordinal in range(
            price_date.year * 12 + price_date.month, calc_date.year * 12 + calc_date.month - 1
        )
    ]
    present = [month for month in months if month in cpi]
    missing = [month for month in months if month not in cpi]
    period = f"{months[0]} — {months[-1]}" if months else "нет полных месяцев"
    note = f"Индексация за {period}; использовано месяцев: {len(present)}"
    if missing:
        note += "; нет данных ИПЦ за: " + ", ".join(missing)
    if not present:
        return IndexResolution(status="no_data", note=note)
    if any(not cpi[month].is_finite() or cpi[month] <= 0 for month in present):
        raise ValueError("ИПЦ должен быть положительным конечным числом")
    with localcontext() as context:
        context.prec = 50
        factor = (1 + sum((cpi[m] - 100 for m in present), Decimal(0)) / 100).quantize(
            Decimal(".0001"), rounding=ROUND_HALF_UP
        )
    return IndexResolution(status="applied", factor=factor, note=note)


def adjusted_price(
    base: Decimal,
    vat: VatResolution,
    idx: IndexResolution,
    delivery: DeliveryResolution,
) -> Decimal:
    with localcontext() as context:
        context.prec = 50
        return money(base * vat.factor * idx.factor) + delivery.added_per_unit


def supplier_key(offer: Offer, rules: Rules) -> str | None:
    if offer.supplier_inn:
        inn = re.sub(r"\D", "", offer.supplier_inn)
        if inn:
            return inn
    if offer.supplier:
        name = re.sub(r'[«»“”"\']', "", offer.supplier.casefold())
        name = re.sub(r"\b(?:ооо|ао|пао|зао|оао|ип)\b", "", name)
        name = " ".join(name.split())
        if name:
            return name
    host = (urlsplit(offer.url).hostname or "").casefold().removeprefix("www.")
    if (
        host
        and offer.source_id != "eis"
        and not any(
            host == marketplace or host.endswith("." + marketplace)
            for marketplace in rules.marketplace_hosts
        )
    ):
        return host
    return None


def _entry_price(entry: OfferEntry) -> Decimal:
    if entry.normalized_price is None:
        raise ValueError("Для отбора и статистики нужна расчётная цена предложения")
    return entry.normalized_price


def pick_per_supplier(
    entries: list[OfferEntry],
    rules: Rules,
) -> tuple[list[OfferEntry], list[tuple[OfferEntry, OfferEntry]]]:
    winners: dict[str, OfferEntry] = {}
    keys = [supplier_key(entry.offer, rules) for entry in entries]

    def rank(entry):
        when = entry.offer.price_date or entry.offer.retrieved_at.date()
        return (-when.toordinal(), _entry_price(entry), entry.offer.id)

    for key, entry in zip(keys, entries, strict=True):
        if key is not None and (key not in winners or rank(entry) < rank(winners[key])):
            winners[key] = entry
    kept, dropped = [], []
    for key, entry in zip(keys, entries, strict=True):
        if key is None or winners[key] is entry:
            kept.append(entry)
        else:
            dropped.append((entry, winners[key]))
    return kept, dropped


def diagnose_spread(entries: list[OfferEntry], rules: Rules) -> list[str]:
    features = [
        (lambda e: e.offer.source_id == "eis", "цен ЕИС", "цен остальных источников"),
        (
            lambda e: e.vat is not None and e.vat.status == "unknown",
            "цен с неизвестным НДС",
            "цен с подтверждённым НДС",
        ),
        (
            lambda e: e.vat is not None and e.vat.status == "exempt",
            "цен поставщиков без НДС",
            "цен с НДС",
        ),
        (
            lambda e: e.indexation is not None and e.indexation.status == "applied",
            "проиндексированных цен",
            "цен без индексации",
        ),
        (
            lambda e: e.delivery is not None and e.delivery.status == "unknown",
            "цен с неизвестной доставкой",
            "цен с подтверждённой доставкой",
        ),
    ]
    hints = []
    for predicate, yes, no in features:
        groups = [
            [_entry_price(e) for e in entries if predicate(e) == flag] for flag in (True, False)
        ]
        if not all(groups):
            continue
        means = [sum(group) / len(group) for group in groups]
        if means[0] == means[1]:
            continue
        low = 0 if means[0] < means[1] else 1
        high = 1 - low
        gap = (means[high] - means[low]) / means[high]
        if gap >= rules.spread_hint_min_gap:
            labels = (yes, no)
            percent = (gap * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)
            hints.append(
                (
                    gap,
                    f"Среднее {labels[low]} на {percent} % ниже {labels[high]} "
                    f"({len(groups[low])} против {len(groups[high])} предложений)",
                )
            )
    return [text for _, text in sorted(hints, key=lambda pair: pair[0], reverse=True)[:3]]
