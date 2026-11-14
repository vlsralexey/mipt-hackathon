from io import BytesIO
from pathlib import Path

import pytest
from docx import Document
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, StreamObject

from app.pipeline.extract_text import MAX_FILE_BYTES, extract_text

FIX = Path(__file__).parent / "fixtures"


@pytest.mark.parametrize(
    "filename,fragments",
    [
        ("ТЗ поставка бумаги.docx", ["SvetoCopy", "2500", "17.12.14.160", "65"]),
        ("ТЗ поставка цитокинов.docx", ["rhIL-21", "Coomassie", "мкг"]),
        ("ТЗ поставка 3D принтер.docx", ["3D", "принтер", "мм"]),
    ],
)
def test_real_specifications(filename, fragments):
    text = extract_text(filename, (FIX / filename).read_bytes())
    assert all(fragment in text for fragment in fragments)
    assert " | " in text


def test_docx_document_order_nested_tables_and_merged_cells():
    doc = Document()
    doc.add_paragraph("Начало")
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "Колонка А"
    table.cell(0, 1).text = "Колонка Б"
    nested = table.cell(0, 1).add_table(rows=1, cols=1)
    nested.cell(0, 0).text = "Вложенная таблица"
    doc.add_paragraph("После таблицы")
    merged = doc.add_table(rows=1, cols=2)
    merged.cell(0, 0).merge(merged.cell(0, 1)).text = "Объединение"
    data = BytesIO()
    doc.save(data)
    text = extract_text("ТЗ.DOCX", data.getvalue())
    assert text.index("Начало") < text.index("Колонка А") < text.index("Колонка Б")
    assert text.index("Вложенная таблица") < text.index("После таблицы") < text.index("Объединение")
    assert text.count("Объединение") == 1


def pdf_bytes(*texts, encrypted=False):
    writer = PdfWriter()
    for text in texts:
        page = writer.add_blank_page(width=300, height=200)
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
        )
        stream = StreamObject()
        stream.set_data(f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
    if encrypted:
        writer.encrypt("password")
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def test_pdf_text_and_page_order():
    text = extract_text("x.pdf", pdf_bytes("First page", "Second page"))
    assert text.index("First page") < text.index("Second page")


@pytest.mark.parametrize("encrypted,match", [(True, "паролем"), (False, "OCR")])
def test_encrypted_and_scanned_pdf(encrypted, match):
    with pytest.raises(ValueError, match=match):
        extract_text("x.pdf", pdf_bytes("", encrypted=encrypted))


@pytest.mark.parametrize("extension", ["txt", "md"])
def test_utf8_and_bom(extension):
    assert (
        extract_text("x." + extension, "\ufeffПозиция\n| Товар | 25 мкг |".encode())
        == "Позиция\n| Товар | 25 мкг |"
    )


@pytest.mark.parametrize(
    "name,data,match",
    [
        ("x.xlsx", b"123", "Неподдерживаемый"),
        ("x.docx", b"bad", "повреждён"),
        ("x.pdf", b"bad", "повреждён"),
        ("x.txt", b"\xff", "UTF-8"),
        ("x.txt", b" \n\t", "не содержит"),
        ("x.txt", b"x" * (MAX_FILE_BYTES + 1), "20 МБ"),
    ],
)
def test_invalid_files(name, data, match):
    with pytest.raises(ValueError, match=match):
        extract_text(name, data)


def test_empty_table_is_not_specification_text():
    doc = Document()
    doc.add_table(rows=2, cols=3)
    data = BytesIO()
    doc.save(data)
    with pytest.raises(ValueError, match="не содержит"):
        extract_text("empty.docx", data.getvalue())
