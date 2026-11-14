from io import BytesIO
from pathlib import Path

from docx import Document

from app.models import Report
from app.report.docx_export import render_docx


def test_docx_contains_auditable_calculation_and_links():
    report = Report.model_validate_json(
        (Path(__file__).parents[2] / "docs/api-examples/report.json").read_text()
    )
    doc = Document(BytesIO(render_docx(report)))
    all_text = "\n".join(p.text for p in doc.paragraphs) + "\n".join(
        c.text for t in doc.tables for r in t.rows for c in r.cells
    )
    for section in [
        "Предмет закупки",
        "Где искали",
        "Включённые предложения",
        "Исключённые предложения",
        "Правки пользователя",
        "Расчёт",
        "Предупреждения",
    ]:
        assert section in all_text
    assert "https://" in all_text and "290,00 ₽" in all_text
    assert "приказ" in all_text and "223-ФЗ" in all_text
    assert "761 250,00 ₽" in all_text
    assert "не обоснована" in all_text
    assert "—" not in all_text and "–" not in all_text
    assert "unit_price" not in all_text
