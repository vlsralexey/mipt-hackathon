from decimal import Decimal
from typing import Literal, Protocol

import httpx
from pydantic import AwareDatetime, Field

from app.config import Rules, SourceConfig
from app.models import DomainModel, Position, SkippedPage, SourceRun


class EisLine(DomainModel):
    index: int
    title: str
    price: Decimal
    amount_unit: str
    vat: Literal["included", "exempt", "unknown"] = "unknown"
    vat_rate: Decimal | None = None
    characteristics: dict[str, str] = Field(default_factory=dict)
    ktru_url: str | None = None


class CandidatePage(DomainModel):
    url: str
    title: str
    text: str
    retrieved_at: AwareDatetime
    eis_lines: list[EisLine] = Field(default_factory=list)


class SourceResult(DomainModel):
    pages: list[CandidatePage] = Field(default_factory=list)
    run: SourceRun
    skipped: list[SkippedPage] = Field(default_factory=list)


class SourceAdapter(Protocol):
    id: str
    name: str
    level: int
    cfg: SourceConfig

    async def search(self, position: Position, rules: Rules) -> SourceResult: ...


def source_error(exc: Exception) -> tuple[str, str]:
    from app.llm.client import LLMAuthError, LLMError
    from app.sources.fetch import NeedsLogin

    if isinstance(exc, LLMAuthError):
        raise exc
    if isinstance(exc, NeedsLogin):
        return "needs_login", "Источник требует входа или проверки капчи"
    if isinstance(exc, httpx.RequestError) or (
        isinstance(exc, httpx.HTTPStatusError)
        and (exc.response.status_code >= 500 or exc.response.status_code == 429)
    ):
        return "unavailable", "Источник недоступен: ошибка сети, таймаут или ограничение запросов"
    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (401, 403):
        return "needs_login", "Источник ограничил доступ к странице"
    if isinstance(exc, LLMError):
        return "error", str(exc)
    return "error", "Не удалось обработать источник: изменился формат страницы или ответа"
