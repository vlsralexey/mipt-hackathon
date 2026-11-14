"""Чистая сборка отчёта из исходных результатов, snapshot и правок P0.

Нет HTTP, LLM, чтения конфигов и текущего времени. Одинаковые входы дают
одинаковый Report, включая created_at. Инструменты создания правок — этап 3.
"""

from datetime import UTC, datetime
from decimal import Decimal
from urllib.parse import parse_qs, urlsplit

from app.config import CalculationSnapshot
from app.models import (
    AppliedEdit,
    CharComparison,
    Edit,
    Offer,
    OfferEntry,
    ParsedTZ,
    Position,
    PositionReport,
    Report,
    ResearchRun,
)
from app.pipeline.calc import calculate, find_outliers, money
from app.pipeline.match import decide, dedupe
from app.pipeline.normalize import (
    adjusted_price,
    diagnose_spread,
    index_price,
    normalize_price,
    pick_per_supplier,
    resolve_delivery,
    resolve_vat,
)
from app.units import UnitMismatch


def active_edits(edits: list[Edit]) -> list[Edit]:
    latest = {}
    for edit in sorted(edits, key=lambda e: e.seq):
        if edit.status != "active":
            continue
        if edit.kind in ("include", "exclude"):
            key = ("selection", edit.payload.offer_id)
        elif edit.kind == "correct_offer":
            key = (edit.kind, edit.payload.offer_id, edit.payload.field)
        elif edit.kind == "answer_question":
            key = (edit.kind, edit.payload.question_id)
        else:
            key = (edit.kind, edit.id)
        latest[key] = edit
    return sorted(latest.values(), key=lambda e: e.seq)


def effective_position(position: Position, edits: list[Edit]) -> Position:
    current = position.model_copy(deep=True)
    for edit in active_edits(edits):
        if edit.kind == "answer_question" and edit.position_index == position.index:
            if edit.payload.position.index != position.index:
                raise ValueError("Правка ответа ссылается на другую позицию")
            current = edit.payload.position.model_copy(deep=True)
    return current


def _comparison(position: Position, saved: list[CharComparison]) -> list[CharComparison]:
    by_name = {c.name.casefold(): c for c in saved}
    rows = []
    for required in position.characteristics:
        found = by_name.get(required.name.casefold())
        # Нельзя переиспользовать «подходит», если изменилось само требование.
        valid = found is not None and found.required == required.value
        rows.append(
            CharComparison(
                name=required.name,
                required=required.value,
                essential=required.essential,
                offered=found.offered if found else None,
                ok=found.ok if valid else None,
            )
        )
    return rows


def _found_offers(runs: list[ResearchRun]):
    latest = {}
    for run in sorted(runs, key=lambda r: (r.created_at, r.id)):
        for found in run.offers:
            latest[found.offer.id] = found
    return list(latest.values())


def build_position(
    position: Position,
    runs: list[ResearchRun],
    snapshot: CalculationSnapshot,
    edits: list[Edit] | None = None,
) -> PositionReport:
    edits = [e for e in active_edits(edits or []) if e.position_index in (None, position.index)]
    position = effective_position(position, edits)
    runs = [r for r in runs if r.position_index == position.index]
    found = _found_offers(runs)
    _, duplicate_offers = dedupe([f.offer for f in found])
    duplicate_ids = {o.id for o in duplicate_offers}
    entries, forced = [], set()
    rules = snapshot.rules
    for f in found:
        offer = f.offer.model_copy(deep=True)
        original, marks = {}, []
        for edit in edits:
            if edit.kind == "correct_offer" and edit.payload.offer_id == offer.id:
                field = edit.payload.field
                original.setdefault(field, str(getattr(f.offer, field)))
                offer = Offer.model_validate(offer.model_dump() | {field: edit.payload.value})
                if "corrected" not in marks:
                    marks.append("corrected")
        comparison = _comparison(position, f.comparison)
        exclusion, reason = decide(comparison)
        entry = OfferEntry(
            offer=offer,
            comparison=comparison,
            exclusion=exclusion,
            reason=reason,
            original=original or None,
            user_marks=marks,
        )
        try:
            entry.base_price = normalize_price(offer, position.basis)
            policy = f.policy
            entry.vat = resolve_vat(
                offer, policy.vat_default, policy.vat_note, rules, policy.price_final
            )
            entry.indexation = index_price(
                offer.price_date, snapshot.calc_date, snapshot.cpi, rules
            )
            entry.delivery = resolve_delivery(
                offer, policy.delivery, entry.base_price, position.quantity
            )
            entry.normalized_price = adjusted_price(
                entry.base_price, entry.vat, entry.indexation, entry.delivery
            )
        except UnitMismatch as exc:
            entry.exclusion, entry.reason = "unit_mismatch", str(exc)
        if offer.id in duplicate_ids:
            entry.exclusion, entry.reason = "duplicate", "Дублирующее предложение"
        for edit in edits:
            if edit.kind not in ("include", "exclude") or edit.payload.offer_id != offer.id:
                continue
            if edit.kind == "exclude":
                entry.exclusion = "user_excluded"
                entry.reason = "Исключено пользователем: " + edit.reason
                entry.user_marks.append(
                    "excluded_by_price" if edit.reason_kind == "price" else "excluded"
                )
            elif entry.exclusion not in ("unit_mismatch", "duplicate"):
                entry.exclusion = None
                entry.reason = "Включено пользователем: " + edit.reason
                entry.user_marks.append("included")
                forced.add(offer.id)
        entries.append(entry)
    eligible = [e for e in entries if e.exclusion is None and e.offer.id not in forced]
    kept, dropped = pick_per_supplier(eligible, rules)
    for entry, winner in dropped:
        entry.exclusion = "same_supplier"
        entry.reason = (
            f"Повторная цена поставщика {entry.offer.supplier or entry.offer.supplier_inn or ''}; "
            f"в расчёт взята более свежая: {winner.offer.url}"
        )
    candidates = kept + [e for e in entries if e.offer.id in forced and e.exclusion is None]
    prices = [e.normalized_price for e in candidates]
    outliers, rule_text = find_outliers(prices, rules)
    for i in outliers:
        candidates[i].exclusion = "anomalous_price"
        candidates[i].reason = "Аномальная цена: " + rule_text
    included = [e for e in entries if e.exclusion is None]
    excluded = [e for e in entries if e.exclusion is not None]
    calc = calculate([e.normalized_price for e in included], rules, outlier_prices=prices)
    assumptions = list(dict.fromkeys(a for r in runs for a in r.assumptions))
    indexed = sum(e.indexation is not None and e.indexation.status == "applied" for e in included)
    if indexed:
        assumptions.append(
            f"Проиндексировано цен: {indexed} (ИПЦ Росстата, порог {rules.index_after_months} мес.)"
        )
    for row, entry in enumerate(included + excluded, 1):
        entry.label = f"{position.index}.{row}"
        entry.caption = f"{entry.offer.source_name}: {entry.offer.title}"
        number = parse_qs(urlsplit(entry.offer.url).query).get("reestrNumber", [None])[0]
        if entry.offer.source_id == "eis" and number:
            entry.caption = f"ЕИС, контракт № {number}"
    return PositionReport(
        position=position,
        status=calc.status,
        levels_used=sorted({s.level for r in runs for s in r.sources}),
        included=included,
        excluded=excluded,
        stats=calc.stats,
        unit_price=calc.unit_price,
        reference_price=calc.reference_price,
        total=money(calc.unit_price * position.quantity) if calc.unit_price is not None else None,
        assumptions=assumptions,
        spread_hints=diagnose_spread(included, rules) if calc.status == "heterogeneous" else [],
        skipped_pages=[p for r in runs for p in r.skipped_pages],
    )


def _warnings(pr: PositionReport) -> list[str]:
    prefix = f"Позиция {pr.position.index} «{pr.position.name}»: "
    rows, result = pr.included, []
    if pr.status == "insufficient":
        result.append(prefix + f"найдено {len(rows)} цен, обоснование недостаточно")
    elif pr.status == "heterogeneous":
        text = prefix + f"выборка неоднородна (CV = {pr.stats.cv * 100:g} %)"
        result.append(text + ("; " + "; ".join(pr.spread_hints) if pr.spread_hints else ""))
    for field, state, label in (
        ("vat", "unknown", "НДС не подтверждён"),
        ("delivery", "unknown", "доставка не подтверждена"),
    ):
        count = sum(
            getattr(e, field) is not None and getattr(e, field).status == state for e in rows
        )
        if count:
            result.append(
                prefix + f"{label} у {count} из {len(rows)} предложений — цена может быть занижена"
            )
    missing = sum(e.indexation is not None and e.indexation.status == "no_data" for e in rows)
    partial = sum(
        e.indexation is not None
        and e.indexation.status == "applied"
        and "нет данных" in e.indexation.note
        for e in rows
    )
    if missing:
        result.append(
            prefix + f"для {missing} цен прошлых периодов нет данных ИПЦ, индексация не применена"
        )
    if partial:
        result.append(prefix + f"для {partial} цен индексация выполнена по неполному ряду ИПЦ")
    if any("неустоек не проверено" in p.reason for p in pr.skipped_pages):
        result.append(prefix + "не по всем контрактам удалось проверить отсутствие неустоек")
    return result


def build_report(
    snapshot: CalculationSnapshot,
    parsed_tz: ParsedTZ,
    runs: list[ResearchRun],
    edits: list[Edit],
    version: int,
    cause: str,
    *,
    procurement_id: str | None = None,
    created_at: datetime | None = None,
) -> Report:
    ids = {r.procurement_id for r in runs}
    if procurement_id is None:
        if len(ids) != 1:
            raise ValueError("Нужно явно указать закупку для отчёта без результатов поиска")
        procurement_id = next(iter(ids))
    if ids - {procurement_id}:
        raise ValueError("Результаты поиска относятся к другой закупке")
    if len({p.index for p in parsed_tz.positions}) != len(parsed_tz.positions):
        raise ValueError("Повторные индексы позиций")
    effective = active_edits(edits)
    questions = [q.model_copy(deep=True) for q in parsed_tz.questions]
    for edit in effective:
        if edit.kind == "answer_question":
            for q in questions:
                if q.id == edit.payload.question_id and q.position_index == edit.position_index:
                    q.answer = edit.payload.answer
    valid_effective = [
        e
        for e in effective
        if e.kind != "answer_question"
        or any(
            q.id == e.payload.question_id and q.position_index == e.position_index
            for q in questions
        )
    ]
    positions = [build_position(p, runs, snapshot, valid_effective) for p in parsed_tz.positions]
    for pr in positions:
        for q in questions:
            if q.position_index == pr.position.index:
                pr.assumptions.append(
                    ("Принято по умолчанию: " + q.default_answer)
                    if q.answer is None
                    else "Ответ пользователя: " + q.answer
                )
    sources = [s for r in runs for s in r.sources]
    warnings = [w for pr in positions for w in _warnings(pr)]
    for source in sources:
        if source.error or source.status in ("unavailable", "error", "needs_login"):
            warnings.append(
                f"Источник «{source.name}», позиция {source.position_index}: "
                + (source.error or "источник недоступен")
            )
    if parsed_tz.delivery_extras:
        warnings.append(
            "Требования ТЗ при поставке ("
            + ", ".join(parsed_tz.delivery_extras)
            + ") в найденных ценах не отражены"
        )
    justified = [p.total for p in positions if p.status == "ok" and p.total is not None]
    applied = []
    entries = {e.offer.id: e for p in positions for e in p.included + p.excluded}
    for edit in effective:
        if edit.kind == "answer_question":
            exists = any(
                q.id == edit.payload.question_id and q.position_index == edit.position_index
                for q in questions
            )
            effect = "Ответ применён к позиции" if exists else "Вопрос не найден"
        elif edit.kind in ("include", "exclude", "correct_offer"):
            target = entries.get(edit.payload.offer_id)
            exists = target is not None
            effect = (
                "Применено к предложению"
                if exists
                else "Не применено: предложение не найдено при поиске"
            )
            if (
                edit.kind == "include"
                and target
                and target.exclusion in ("unit_mismatch", "duplicate", "anomalous_price")
            ):
                exists, effect = False, "Включение невозможно: " + target.reason
        else:
            exists, effect = False, "Этот вид правки не входит в P0"
        applied.append(AppliedEdit(edit=edit, applied=exists, effect=effect))
        if edit.kind == "exclude" and exists and edit.reason_kind == "price":
            warnings.append(
                "Предложение исключено пользователем по цене; это влияет на обоснование НМЦК"
            )
    times = [r.created_at for r in runs] + [e.created_at for e in effective]
    at = created_at or max(
        times, default=datetime.combine(snapshot.calc_date, datetime.min.time(), UTC)
    )
    return Report(
        procurement_id=procurement_id,
        version=version,
        created_at=at,
        title=parsed_tz.title,
        calc_date=snapshot.calc_date,
        methodology=snapshot.rules.methodology_note,
        cause=cause,
        positions=positions,
        sources=sources,
        questions=questions,
        delivery_terms=parsed_tz.delivery_terms,
        delivery_extras=parsed_tz.delivery_extras,
        total=money(sum(justified, Decimal(0)))
        if positions and len(justified) == len(positions)
        else None,
        total_justified=money(sum(justified, Decimal(0))) if justified else None,
        warnings=list(dict.fromkeys(warnings)),
        edits=applied,
        rules=snapshot.rules.model_dump(mode="json"),
    )
