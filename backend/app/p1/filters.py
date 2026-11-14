"""Проверка фильтров предложений: все условия соединяются через И."""

from app.models import OfferEntry, OfferFilter


def matches(entry: OfferEntry, filters: OfferFilter) -> bool:
    offer = entry.offer
    if filters.source_ids and offer.source_id not in filters.source_ids:
        return False
    if filters.levels and offer.level not in filters.levels:
        return False
    for bound, before in ((filters.price_date_before, True), (filters.price_date_after, False)):
        if bound is not None and (
            offer.price_date is None
            or (offer.price_date >= bound if before else offer.price_date <= bound)
        ):
            return False
    if filters.normalized_price_above is not None and (
        entry.normalized_price is None or entry.normalized_price <= filters.normalized_price_above
    ):
        return False
    if filters.normalized_price_below is not None and (
        entry.normalized_price is None or entry.normalized_price >= filters.normalized_price_below
    ):
        return False
    if filters.vat_status and (entry.vat is None or entry.vat.status not in filters.vat_status):
        return False
    if filters.delivery_status and (
        entry.delivery is None or entry.delivery.status not in filters.delivery_status
    ):
        return False
    if filters.supplier and filters.supplier.casefold() not in (offer.supplier or "").casefold():
        return False
    return True
