from pathlib import Path

from app.api.models import Procurement
from app.models import Report

EXAMPLES = Path(__file__).parents[2] / "docs" / "api-examples"


def test_public_examples_validate():
    procurement = Procurement.model_validate_json((EXAMPLES / "procurement.json").read_text())
    report = Report.model_validate_json((EXAMPLES / "report.json").read_text())
    assert procurement.latest_version == report.version
    assert procurement.total_justified == report.total_justified
    assert {m.kind for m in procurement.messages} >= {"run", "version", "question"}


def test_public_text_does_not_change_source_identity():
    report = Report.model_validate_json((EXAMPLES / "report.json").read_text())
    report.methodology = "Методика — пояснение 1–2"
    offer = report.positions[0].included[0].offer
    offer.url = "https://example.org/item/А–Б"
    data = report.model_dump(mode="json")
    assert data["methodology"] == "Методика : пояснение 1-2"
    assert data["positions"][0]["included"][0]["offer"]["url"] == offer.url
