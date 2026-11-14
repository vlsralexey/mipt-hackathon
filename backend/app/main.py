"""Точка входа FastAPI. Запуск не требует доступа к OpenRouter."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles

from app.api.limits import UploadLimitMiddleware
from app.api.routes import router
from app.browser.routes import router as browser_router
from app.config import Settings
from app.p1.actions import router as actions_router
from app.p1.configuration_routes import router as configuration_router
from app.service import ActionError, Service, open_runtime
from app.store.repo import Repo


class HealthResponse(BaseModel):
    status: str = "ok"


def create_app(settings: Settings | None = None, *, runtime_factory=open_runtime) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        current_settings = settings if settings is not None else Settings()
        current_settings.prepare_directories()
        application.state.settings = current_settings
        application.state.frontend = (
            StaticFiles(directory=current_settings.frontend_dir)
            if current_settings.frontend_dir is not None
            else None
        )
        service = Service(Repo(current_settings.database_path), current_settings, runtime_factory)
        application.state.service = service
        await service.start()
        try:
            yield
        finally:
            await service.close()

    application = FastAPI(title="Агент НМЦК", version="0.1.0", lifespan=lifespan)
    application.include_router(router)
    application.include_router(browser_router)
    application.include_router(actions_router)
    application.include_router(configuration_router)
    application.add_middleware(UploadLimitMiddleware)

    @application.exception_handler(ActionError)
    async def action_error(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @application.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return JSONResponse(
            {"detail": "Неверный формат запроса. Проверьте поля и значения."}, status_code=422
        )

    @application.exception_handler(HTTPException)
    async def http_error(request, exc):
        detail = {404: "Адрес не найден", 413: "Размер файла ТЗ превышает 20 МБ"}.get(
            exc.status_code, "Запрос не может быть выполнен"
        )
        return JSONResponse({"detail": detail}, status_code=exc.status_code)

    @application.exception_handler(Exception)
    async def internal_error(request, exc):
        return JSONResponse({"detail": "Внутренняя ошибка сервера"}, status_code=500)

    @application.get("/api/health", tags=["Сервис"])
    async def health() -> HealthResponse:
        return HealthResponse()

    @application.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str, request: Request):
        files = request.app.state.frontend
        if files is None or path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404)
        # Маршруты React Router открываются напрямую и после перезагрузки.
        if path in ("", "new", "settings") or path.startswith("p/"):
            response = await files.get_response("index.html", request.scope)
            response.headers["Cache-Control"] = "no-cache"
            return response
        return await files.get_response(path, request.scope)

    return application


app = create_app()
