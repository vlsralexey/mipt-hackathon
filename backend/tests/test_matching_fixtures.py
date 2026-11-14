"""Офлайн-набор сопоставления из живых прогонов трёх демонстрационных ТЗ.

Ответы LLM записаны во время прогонов и подставляются без сети; решение
«подходит / несопоставимо / недостаточно данных» принимает код.
Происхождение и пояснение — в полях provenance и note каждого случая.
"""

import json
from pathlib import Path

import pytest
from fakes import FakeLLM

from app.config import SourceConfig
from app.models import Offer, Position
from app.pipeline.extract import extract_offers
from app.pipeline.match import compare, decide
from app.sources.base import CandidatePage

FIXTURES = Path(__file__).parent / "fixtures" / "matching"
COMPARE = json.loads((FIXTURES / "compare_cases.json").read_text(encoding="utf-8"))
EXTRACT = json.loads((FIXTURES / "extract_cases.json").read_text(encoding="utf-8"))


class Source:
    def __init__(self, url):
        kind = "eis" if "zakupki.gov.ru" in url else "web"
        self.cfg = SourceConfig(id=kind, name=kind, level=1, type=kind)
        self.id, self.name, self.level = self.cfg.id, self.cfg.name, self.cfg.level


@pytest.mark.parametrize("case", COMPARE, ids=[c["id"] for c in COMPARE])
async def test_recorded_offer_decision(case):
    position = Position.model_validate(case["position"])
    offer = Offer.model_validate(case["offer"])
    comparison = await compare(FakeLLM([case["llm"]]), position, offer)
    assert decide(comparison)[0] == case["expected"], case["note"]


@pytest.mark.parametrize("case", EXTRACT, ids=[c["id"] for c in EXTRACT])
async def test_recorded_page_extraction(case):
    position = Position.model_validate(case["position"])
    page = CandidatePage.model_validate(case["page"])
    offers, failures = await extract_offers(
        FakeLLM([case["llm"]]), position, page, Source(page.url)
    )
    expected = case["expected"]
    assert len(offers) == expected["offers"], case["note"]
    if "failure" in expected:
        assert any(expected["failure"] in f.reason for f in failures), failures
    raw = {c["name"] for o in case["llm"]["offers"] for c in o["characteristics"]}
    for offer in offers:
        assert set(expected["dropped"]) == raw - set(offer.characteristics), case["note"]
