"""Публичный каталог OpenRouter без ключа и пользовательских данных."""

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.api.models import OpenRouterModel

URL = "https://openrouter.ai/api/v1/models"


class CatalogError(Exception):
    pass


class Architecture(BaseModel):
    input_modalities: list[str]
    output_modalities: list[str]


class CatalogModel(BaseModel):
    id: str = Field(min_length=1, pattern=r"\S")
    name: str = Field(min_length=1, pattern=r"\S")
    architecture: Architecture
    endpoints: list[str] | None = None


class Catalog(BaseModel):
    data: list[CatalogModel]


async def fetch_models(http: httpx.AsyncClient) -> list[OpenRouterModel]:
    try:
        response = await http.get(URL)
        response.raise_for_status()
        catalog = Catalog.model_validate(response.json())
    except (httpx.HTTPError, ValueError, ValidationError) as exc:
        raise CatalogError(
            "Не удалось загрузить модели OpenRouter. Повторите загрузку или укажите ID вручную."
        ) from exc
    models = {
        model.id: OpenRouterModel(id=model.id, name=model.name)
        for model in catalog.data
        if "text" in model.architecture.input_modalities
        and "text" in model.architecture.output_modalities
        and (model.endpoints is None or "/api/v1/chat/completions" in model.endpoints)
    }
    return sorted(models.values(), key=lambda model: (model.name.casefold(), model.id))
