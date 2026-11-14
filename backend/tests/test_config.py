from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.config import (
    DEFAULT_CONFIG_DIR,
    DEFAULT_MODEL,
    DeliveryPolicy,
    Rules,
    Settings,
    SourceConfig,
    load_cpi,
    load_rules,
    load_sources,
    policy_for,
    save_config,
)


def test_rules_override_and_decimal_yaml(tmp_path):
    path = tmp_path / "rules.yaml"
    path.write_text("cv_threshold: 0.123456789123456789\n")
    assert load_rules(path).cv_threshold == Decimal("0.123456789123456789")
    assert load_rules(path).min_prices == 3
    assert load_rules(DEFAULT_CONFIG_DIR / "rules.yaml") == Rules()


def test_sources_policies():
    sources = {s.id: s for s in load_sources(DEFAULT_CONFIG_DIR / "sources.yaml")}
    assert {s.level for s in sources.values() if s.enabled} == {1, 2}
    eis = sources["eis"]
    assert eis.price_final and eis.delivery.included and eis.delivery.note
    assert eis.vat_default == sources["web_shops"].vat_default == "included"
    assert sources["web_suppliers"].vat_default == "unknown"
    cfg = SourceConfig(
        id="w",
        name="w",
        level=2,
        type="web",
        site_delivery={"komus.ru": DeliveryPolicy(free_from=Decimal(5000))},
    )
    assert policy_for(cfg, "https://www.komus.ru/p/1").free_from == 5000
    assert policy_for(cfg, "https://fakekomus.ru/p/1") == cfg.delivery


def test_cpi_missing_empty_and_exact(tmp_path):
    path = tmp_path / "cpi.yaml"
    assert load_cpi(path) == {}
    path.write_text("'2026-05': 100.123456789123456789\n")
    assert load_cpi(path) == {"2026-05": Decimal("100.123456789123456789")}
    assert load_cpi(DEFAULT_CONFIG_DIR / "cpi.yaml") == {}


@pytest.mark.parametrize("text", ["'2026-13': 100", "'2026-01': 0", "'2026-01': .nan", "[]"])
def test_reject_invalid_cpi(tmp_path, text):
    path = tmp_path / "cpi.yaml"
    path.write_text(text)
    with pytest.raises(ValueError):
        load_cpi(path)


def test_config_initialization_and_validated_atomic_write(tmp_path):
    settings = Settings(_env_file=None, data_dir=tmp_path, openrouter_model="")
    assert settings.openrouter_model == DEFAULT_MODEL
    settings.prepare_directories()
    path = settings.effective_config_dir / "rules.yaml"
    save_config(path, {"cv_threshold": ".25"})
    settings.prepare_directories()
    assert load_rules(path).cv_threshold == Decimal(".25")
    before = path.read_bytes()
    with pytest.raises(ValidationError):
        save_config(path, {"cv_thresold": ".3"})
    assert path.read_bytes() == before
    with pytest.raises(ValidationError):
        save_config(path, {"min_prices": 0})
    assert not list(path.parent.glob(".*.yaml.*"))


def test_sources_roundtrip_and_duplicate_ids(tmp_path):
    path = tmp_path / "sources.yaml"
    sources = load_sources(DEFAULT_CONFIG_DIR / "sources.yaml")
    save_config(path, sources)
    assert load_sources(path) == sources
    with pytest.raises(ValueError):
        save_config(path, [sources[0], sources[0]])


def test_mutated_model_cannot_bypass_config_validation(tmp_path):
    rules = Rules()
    rules.min_prices = 0
    with pytest.raises(ValidationError):
        save_config(tmp_path / "rules.yaml", rules)
    assert not (tmp_path / "rules.yaml").exists()
