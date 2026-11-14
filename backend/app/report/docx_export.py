"""Отчёт DOCX из сохранённой версии: без LLM, сети и повторного расчёта."""

from collections import Counter
from decimal import ROUND_HALF_UP, Decimal
from io import BytesIO

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

from app.models import Report


def money(value):
    if value is None:
        return "не обоснована"
    return f"{value:,.2f}".replace(",", " ").replace(".", ",") + " ₽"


def percent(value):
    return (
        f"{(value * 100).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)}".replace(".", ",") + " %"
    )


def text(value):
    return str(value).replace("—", ":").replace("–", "-")


def paragraph(doc, value, *, bold=False, keep=False):
    p = doc.add_paragraph()
    p.add_run(text(value)).bold = bold
    p.paragraph_format.keep_with_next = keep
    return p


def table(doc, headers, rows):
    result = doc.add_table(rows=1, cols=len(headers))
    result.style = "Table Grid"
    result.autofit = False
    widths = [8, 9] if len(headers) == 2 else [3, 3, 11] if headers[0] == "Поправка" else [5, 7, 5]
    for column, width in zip(result.columns, widths, strict=True):
        column.width = Cm(width)
    for cell, value in zip(result.rows[0].cells, headers, strict=True):
        cell.text = text(value)
        for run in cell.paragraphs[0].runs:
            run.bold = True
    header = OxmlElement("w:tblHeader")
    result.rows[0]._tr.get_or_add_trPr().append(header)
    for row in rows:
        for cell, value in zip(result.add_row().cells, row, strict=True):
            cell.text = text(value)
    for row in result.rows:
        prop = OxmlElement("w:cantSplit")
        row._tr.get_or_add_trPr().append(prop)
        for cell, width in zip(row.cells, widths, strict=True):
            cell.width = Cm(width)
            margins = OxmlElement("w:tcMar")
            for side in ("top", "bottom"):
                edge = OxmlElement(f"w:{side}")
                edge.set(qn("w:w"), "70")
                edge.set(qn("w:type"), "dxa")
                margins.append(edge)
            cell._tc.get_or_add_tcPr().append(margins)
    return result


def offers(doc, rows):
    if not rows:
        paragraph(doc, "Предложений нет.")
    for entry in rows:
        offer = entry.offer
        doc.add_heading(text(f"{entry.label} {entry.caption}"), level=3)
        paragraph(doc, offer.url, keep=True)
        paragraph(
            doc,
            f"Получено: {offer.retrieved_at.isoformat()}. "
            f"Дата цены: {offer.price_date or 'не указана'}. "
            f"Поставщик: {offer.supplier or 'не указан'}, "
            f"ИНН: {offer.supplier_inn or 'не указан'}.",
            keep=True,
        )
        paragraph(
            doc,
            f"Цена источника: {money(offer.price)} за {offer.amount} {offer.amount_unit}. "
            f"За единицу ТЗ до поправок: {money(entry.base_price)}.",
            keep=True,
        )
        stages = []
        if entry.vat:
            stages.append(("НДС", f"× {entry.vat.factor}", entry.vat.note))
        if entry.indexation:
            stages.append(("Индексация", f"× {entry.indexation.factor}", entry.indexation.note))
        if entry.delivery:
            stages.append(
                ("Доставка", f"+ {money(entry.delivery.added_per_unit)}", entry.delivery.note)
            )
        if stages:
            table(doc, ["Поправка", "Значение", "Основание"], stages)
        paragraph(
            doc, f"Расчётная цена: {money(entry.normalized_price)}. {entry.reason}", bold=True
        )
        for c in entry.comparison:
            state = "подходит" if c.ok else "не подходит" if c.ok is False else "нет подтверждения"
            paragraph(
                doc,
                f"{c.name}: требуется {c.required}; найдено {c.offered or 'нет данных'}; "
                f"{'существенная' if c.essential else 'справочная'}; {state}.",
            )
        if entry.original:
            paragraph(
                doc,
                "Исходные значения до правок: "
                + "; ".join(f"{k}: {v}" for k, v in entry.original.items()),
            )
        if entry.user_marks:
            marks = {
                "corrected": "исправлено пользователем",
                "added": "добавлено пользователем",
                "included": "возвращено пользователем",
                "excluded": "исключено пользователем",
                "excluded_by_price": "исключено пользователем по цене",
            }
            paragraph(doc, "Пометки: " + ", ".join(marks[m] for m in entry.user_marks))


def render_docx(report: Report, title: str | None = None) -> bytes:
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21), Cm(29.7)
    section.top_margin = section.bottom_margin = Cm(1.8)
    section.left_margin = section.right_margin = Cm(2)
    for name in ("Normal", "Title", "Heading 1", "Heading 2", "Heading 3"):
        style = doc.styles[name]
        style.font.name = "Calibri"
        style.font.color.rgb = RGBColor(0, 0, 0)
    normal = doc.styles["Normal"]
    normal.font.size = Pt(10)
    normal.paragraph_format.space_after = Pt(5)
    doc.add_heading("Обоснование НМЦК", 0)
    paragraph(doc, title or report.title, bold=True)
    paragraph(
        doc,
        f"Версия {report.version}. Дата расчёта: {report.calc_date}. "
        f"Сформировано: {report.created_at.isoformat()}.",
    )
    paragraph(
        doc,
        f"Итог НМЦК: {money(report.total)}. "
        f"Сумма по обоснованным позициям: {money(report.total_justified)}.",
    )
    doc.add_heading("Предмет закупки", 1)
    for p in report.positions:
        paragraph(
            doc,
            f"{p.position.index}. {p.position.name}: {p.position.quantity} {p.position.unit}. "
            f"База: {p.position.basis.per_tz_unit} {p.position.basis.unit} на единицу ТЗ.",
        )
        for c in p.position.characteristics:
            paragraph(
                doc,
                f"{c.name}: {c.value} {c.unit or ''}; "
                f"{'существенная' if c.essential else 'справочная'}.",
            )
    if report.delivery_terms:
        paragraph(doc, "Условия поставки: " + report.delivery_terms)
    if report.delivery_extras:
        paragraph(doc, "Дополнительные работы: " + ", ".join(report.delivery_extras))
    doc.add_heading("Где искали", 1)
    if report.sources:
        table(
            doc,
            ["Позиция и источник", "Запросы", "Результат"],
            [
                (
                    f"{s.position_index}. {s.name}, уровень {s.level}",
                    "; ".join(s.queries),
                    f"Найдено: {s.found}. "
                    + (
                        s.error
                        or {
                            "ok": "проверен",
                            "empty": "пусто",
                            "unavailable": "недоступен",
                            "error": "ошибка",
                            "needs_login": "требуется вход",
                            "skipped": "пропущен",
                        }[s.status]
                    ),
                )
                for s in report.sources
            ],
        )
    else:
        paragraph(doc, "Сведения об источниках отсутствуют.")
    for heading, field in (
        ("Включённые предложения", "included"),
        ("Исключённые предложения", "excluded"),
    ):
        doc.add_heading(heading, 1)
        for p in report.positions:
            doc.add_heading(text(f"Позиция {p.position.index} {p.position.name}"), 2)
            offers(doc, getattr(p, field))
            if field == "excluded":
                for skip in p.skipped_pages:
                    paragraph(doc, f"Пропуск: {skip.url}. {skip.reason}")
    doc.add_heading("Правки пользователя", 1)
    if not report.edits:
        paragraph(doc, "Действующих правок нет.")
    for applied in report.edits:
        edit = applied.edit
        paragraph(
            doc,
            f"{edit.seq}. {edit.summary}. Причина: {edit.reason}. "
            f"{applied.effect}. Дата: {edit.created_at.isoformat()}.",
        )
    doc.add_heading("Расчёт", 1)
    paragraph(doc, report.methodology)
    paragraph(
        doc,
        "Расчётная цена = цена за единицу ТЗ × коэффициент НДС × коэффициент ИПЦ "
        "+ доставка на единицу. НМЦК позиции = среднее включённых цен × количество. "
        "Итог доступен, когда обоснованы все позиции.",
    )
    for p in report.positions:
        doc.add_heading(text(f"Позиция {p.position.index} {p.position.name}"), 2)
        if p.stats:
            s = p.stats
            table(
                doc,
                ["Показатель", "Значение"],
                [
                    ("Число цен", s.n),
                    ("Минимум", money(s.min)),
                    ("Максимум", money(s.max)),
                    ("Среднее", money(s.mean)),
                    ("СКО", money(s.std)),
                    ("CV", percent(s.cv)),
                    ("Медиана до исключения выбросов", money(s.median)),
                    ("Правило выбросов", s.outlier_rule),
                    ("НМЦК за единицу", money(p.unit_price)),
                    ("Справочная цена", money(p.reference_price)),
                    ("НМЦК позиции", money(p.total)),
                ],
            )
        else:
            paragraph(doc, "Цен для расчёта нет.")
        for field, label in (
            ("vat", "НДС"),
            ("indexation", "Индексация"),
            ("delivery", "Доставка"),
        ):
            counts = Counter(getattr(e, field).status for e in p.included if getattr(e, field))
            names = {
                "included": "включено",
                "added": "добавлено",
                "exempt": "не облагается",
                "unknown": "не подтверждено",
                "applied": "применена",
                "no_data": "нет индексов",
                "not_needed": "не требуется",
            }
            paragraph(
                doc,
                label
                + ": "
                + (", ".join(f"{names[k]}: {v}" for k, v in sorted(counts.items())) or "нет цен"),
            )
        for assumption in p.assumptions:
            paragraph(doc, assumption)
    doc.add_heading("Предупреждения", 1)
    for warning in report.warnings or ["Предупреждений нет."]:
        paragraph(doc, warning)
    stream = BytesIO()
    for root in (doc._element, doc.styles.element):
        for border in root.xpath(".//w:pBdr"):
            border.getparent().remove(border)
    doc.save(stream)
    return stream.getvalue()
