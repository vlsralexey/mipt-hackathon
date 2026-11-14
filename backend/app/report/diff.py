"""Разница версий: числа и перемещения строк определяет код."""

from app.models import Change, OfferMove, PositionChange, Report, RuleChange, VersionDiff
from app.p1.configuration_helpers import TITLES, display
from app.presentation import public_text


def version_diff(before: Report | None, after: Report) -> VersionDiff:
    positions = []
    previous = {p.position.index: p for p in before.positions} if before else {}
    moved = []
    for p in after.positions:
        old = previous.get(p.position.index)
        values = {}
        for name in ("status", "unit_price", "n", "cv"):

            def value(row, field):
                if row is None:
                    return None
                if field in ("n", "cv"):
                    return getattr(row.stats, field) if row.stats else (0 if field == "n" else None)
                return getattr(row, field)

            values[name] = Change(before=value(old, name), after=value(p, name))
        if any(c.before != c.after for c in values.values()):
            positions.append(PositionChange(index=p.position.index, name=p.position.name, **values))
        states = {e.offer.id: "included" for e in old.included} if old else {}
        states.update({e.offer.id: "excluded" for e in old.excluded} if old else {})
        for to, rows in (("included", p.included), ("excluded", p.excluded)):
            for entry in rows:
                if entry.offer.id in states and states[entry.offer.id] != to:
                    moved.append(
                        OfferMove(
                            offer_id=entry.offer.id,
                            label=entry.label,
                            caption=entry.caption,
                            position_index=p.position.index,
                            to=to,
                            reason=entry.reason,
                        )
                    )
    old_ids = {e.edit.id for e in before.edits} if before else set()
    new_ids = {e.edit.id for e in after.edits}
    return VersionDiff(
        from_version=before.version if before else None,
        to_version=after.version,
        total=Change(before=before.total if before else None, after=after.total),
        total_justified=Change(
            before=before.total_justified if before else None, after=after.total_justified
        ),
        positions=positions,
        offers_moved=moved,
        edits_added=sorted(new_ids - old_ids),
        edits_cancelled=sorted(old_ids - new_ids),
        rules_changed=[
            RuleChange(
                key=key,
                title=TITLES.get(key, key),
                before=display(key, (before.rules if before else {}).get(key)),
                after=display(key, value),
            )
            for key, value in after.rules.items()
            if before is not None and public_text(before.rules.get(key)) != public_text(value)
        ],
    )
