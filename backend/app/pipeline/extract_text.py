"""Извлечение текста без LLM и сети, с таблицами в порядке документа."""

from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from docx import Document
from docx.oxml.exceptions import InvalidXmlError
from docx.table import Table
from docx.text.paragraph import Paragraph
from lxml.etree import XMLSyntaxError
from pypdf import PdfReader
from pypdf.errors import PdfReadError

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_DOCX_UNPACKED_BYTES = 100 * 1024 * 1024


def _blocks(container) -> list[str]:
    result = []
    for block in container.iter_inner_content():
        if isinstance(block, Paragraph):
            result.append(block.text)
        elif isinstance(block, Table):
            for row in block.rows:
                cells = []
                last = None
                for cell in row.cells:
                    # Горизонтальное объединение возвращает одну XML-ячейку несколько раз.
                    if cell._tc is not last:
                        cells.append("\n".join(_blocks(cell)))
                    last = cell._tc
                if any(cell.strip() for cell in cells):
                    result.append(" | ".join(cells))
    return result


def extract_text(filename: str, data: bytes) -> str:
    suffix = Path(filename).suffix.casefold()
    if suffix not in {".docx", ".pdf", ".txt", ".md"}:
        raise ValueError(f"Неподдерживаемый формат файла: {suffix or 'без расширения'}")
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("Размер файла ТЗ превышает 20 МБ")
    try:
        if suffix == ".docx":
            with ZipFile(BytesIO(data)) as archive:
                if sum(item.file_size for item in archive.infolist()) > MAX_DOCX_UNPACKED_BYTES:
                    raise ValueError("Слишком большой распакованный документ DOCX")
            text = "\n".join(_blocks(Document(BytesIO(data))))
        elif suffix == ".pdf":
            reader = PdfReader(BytesIO(data))
            if reader.is_encrypted:
                raise ValueError("PDF защищён паролем; загрузите документ без защиты")
            text = "\n\n".join(
                page.extract_text(extraction_mode="layout") or "" for page in reader.pages
            )
        else:
            text = data.decode("utf-8-sig")
    except UnicodeError as exc:
        raise ValueError("Текстовый файл должен быть в кодировке UTF-8") from exc
    except (BadZipFile, KeyError, XMLSyntaxError, InvalidXmlError, PdfReadError) as exc:
        raise ValueError(
            f"Не удалось прочитать {suffix}: файл повреждён или имеет другой формат"
        ) from exc
    if not text.strip():
        if suffix == ".pdf":
            raise ValueError("PDF не содержит текста; для скана требуется распознавание OCR")
        raise ValueError("ТЗ не содержит текста")
    return text.strip()
