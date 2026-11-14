"""Настройки процесса и валидируемые методические конфиги в постоянном каталоге."""

import os
import re
import tempfile
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

import yaml
from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.models import DeliveryPolicy, DomainModel

DEFAULT_MODEL = "openai/gpt-4.1-mini"
_PACKAGED_CONFIG = Path(__file__).parent / "default_config"
DEFAULT_CONFIG_DIR = (
    _PACKAGED_CONFIG if _PACKAGED_CONFIG.is_dir() else Path(__file__).parents[1] / "config"
)


class Rules(DomainModel):
    min_prices: int = Field(default=3, ge=1)
    cv_threshold: Decimal = Field(default=Decimal(".33"), gt=0, le=1)
    iqr_k: Decimal = Field(default=Decimal("1.5"), gt=0)
    iqr_min_n: int = Field(default=5, ge=4)
    median_max_deviation: Decimal = Field(default=Decimal(".5"), gt=0)
    level2_trigger_min_prices: int = Field(default=3, ge=1)
    level2_on_heterogeneous: bool = True
    vat_rate: Decimal = Field(default=Decimal(".22"), ge=0, le=Decimal(".3"))
    indexation_enabled: bool = True
    index_after_months: int = Field(default=6, ge=0)
    spread_hint_min_gap: Decimal = Field(default=Decimal(".15"), ge=0, le=1)
    marketplace_hosts: list[str] = Field(
        default_factory=lambda: ["market.yandex.ru", "ozon.ru", "wildberries.ru"]
    )
    methodology_note: str = (
        "Метод сопоставимых рыночных цен (анализа рынка). Формулы — по аналогии с "
        "Методическими рекомендациями, утверждёнными приказом Минэкономразвития России "
        "от 02.10.2013 № 567; для закупок по 44-ФЗ рекомендации применяются с учётом "
        "действующего законодательства, для закупок по 223-ФЗ — положения о закупке заказчика."
    )
    eis_years: int = Field(default=3, ge=1)
    max_pages_per_source: int = Field(default=8, ge=1)
    page_text_limit: int = Field(default=15000, ge=1)


class SourceConfig(DomainModel):
    id: str = Field(min_length=1)
    name: str
    level: Literal[1, 2]
    type: Literal["eis", "web"]
    enabled: bool = True
    params: dict = Field(default_factory=dict)
    vat_default: Literal["included", "unknown"] = "unknown"
    vat_note: str | None = None
    price_final: bool = False
    delivery: DeliveryPolicy = Field(default_factory=DeliveryPolicy)
    site_delivery: dict[str, DeliveryPolicy] = Field(default_factory=dict)


class CalculationSnapshot(DomainModel):
    calc_date: date
    rules: Rules
    cpi: dict[str, Annotated[Decimal, Field(gt=0)]]


class _DecimalLoader(yaml.SafeLoader):
    pass


_DecimalLoader.add_constructor(
    "tag:yaml.org,2002:float", lambda loader, node: Decimal(loader.construct_scalar(node))
)


def _read_yaml(path: Path):
    try:
        return yaml.load(path.read_text(encoding="utf-8"), Loader=_DecimalLoader)
    except (yaml.YAMLError, UnicodeError, InvalidOperation) as exc:
        raise ValueError(f"Некорректный YAML в {path.name}") from exc


def load_rules(path: Path) -> Rules:
    data = _read_yaml(path)
    return Rules.model_validate({} if data is None else data)


def _sources(data) -> list[SourceConfig]:
    if not isinstance(data, list):
        raise ValueError("Источники должны быть списком")
    sources = [SourceConfig.model_validate(item) for item in data]
    if len({s.id for s in sources}) != len(sources):
        raise ValueError("Идентификаторы источников должны быть уникальными")
    return sources


def load_sources(path: Path) -> list[SourceConfig]:
    return _sources(_read_yaml(path))


def _cpi(data) -> dict[str, Decimal]:
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError("ИПЦ должен быть таблицей YYYY-MM: индекс")
    result = {}
    for month, raw in data.items():
        if not isinstance(month, str) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
            raise ValueError("Месяц ИПЦ должен иметь формат YYYY-MM")
        try:
            value = Decimal(str(raw))
        except InvalidOperation as exc:
            raise ValueError(f"Неверный ИПЦ за {month}") from exc
        if not value.is_finite() or value <= 0:
            raise ValueError(f"ИПЦ за {month} должен быть положительным конечным числом")
        result[month] = value
    return result


def load_cpi(path: Path) -> dict[str, Decimal]:
    return _cpi(_read_yaml(path)) if path.exists() else {}


def policy_for(cfg: SourceConfig, url: str) -> DeliveryPolicy:
    host = (urlsplit(url).hostname or "").lower().removeprefix("www.")
    return cfg.site_delivery.get(host, cfg.delivery)


def _atomic_write(path: Path, data: bytes, *, overwrite: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if overwrite:
            os.replace(temporary, path)
        else:
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
    finally:
        Path(temporary).unlink(missing_ok=True)


def save_config(path: Path, data) -> None:
    """Единая точка записи: полная валидация до атомарной замены файла."""
    if path.name == "rules.yaml":
        model = Rules.model_validate(data)
        serialized = model.model_dump(mode="json")
    elif path.name == "sources.yaml":
        serialized = [s.model_dump(mode="json") for s in _sources(data)]
    elif path.name == "cpi.yaml":
        serialized = {key: str(value) for key, value in _cpi(data).items()}
    else:
        raise ValueError("Неизвестный методический конфиг")
    _atomic_write(path, yaml.safe_dump(serialized, allow_unicode=True).encode(), overwrite=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )
    data_dir: Path = Path("data")
    config_dir: Path | None = None
    openrouter_api_key: SecretStr | None = None
    openrouter_model: str = DEFAULT_MODEL

    @field_validator("openrouter_model", mode="before")
    @classmethod
    def empty_model_uses_default(cls, value):
        return value.strip() or DEFAULT_MODEL

    @property
    def effective_config_dir(self) -> Path:
        return self.config_dir if self.config_dir is not None else self.data_dir / "config"

    @property
    def database_path(self) -> Path:
        return self.data_dir / "nmck.sqlite3"

    def prepare_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.effective_config_dir.mkdir(parents=True, exist_ok=True)
        for filename in ("rules.yaml", "sources.yaml", "cpi.yaml"):
            _atomic_write(
                self.effective_config_dir / filename,
                (DEFAULT_CONFIG_DIR / filename).read_bytes(),
                overwrite=False,
            )
        load_rules(self.effective_config_dir / "rules.yaml")
        load_sources(self.effective_config_dir / "sources.yaml")
        load_cpi(self.effective_config_dir / "cpi.yaml")
