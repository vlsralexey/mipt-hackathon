"""Точка входа FastAPI. Запуск не требует доступа к OpenRouter."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel

from app.config import Settings


class HealthResponse(BaseModel):
    status: str = "ok"


def create_app(settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        current_settings = settings if settings is not None else Settings()
        current_settings.prepare_directories()
        application.state.settings = current_settings
        yield

    application = FastAPI(title="Агент НМЦК", version="0.1.0", lifespan=lifespan)

    @application.get("/api/health", tags=["Сервис"])
    async def health() -> HealthResponse:
        return HealthResponse()

    return application


app = create_app()
