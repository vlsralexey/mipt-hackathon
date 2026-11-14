"""Ограничение тела загрузки до разбора multipart, включая запросы без Content-Length."""

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from app.pipeline.extract_text import MAX_FILE_BYTES


class UploadLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or scope["path"] != "/api/procurements"
        ):
            return await self.app(scope, receive, send)
        maximum = MAX_FILE_BYTES + 128 * 1024  # multipart-заголовки и сообщение рядом с ТЗ
        headers = dict(scope["headers"])
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            declared = 0
        if declared > maximum:
            return await JSONResponse(
                {"detail": "Размер файла ТЗ превышает 20 МБ"}, status_code=413
            )(scope, receive, send)
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > maximum:
                raise HTTPException(413)
            return message

        await self.app(scope, limited_receive, send)
