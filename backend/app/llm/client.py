"""OpenRouter: структурированные ответы, tool calls и ограниченные повторы.

Транспорт подменяется httpx.MockTransport. Клиент закрывает только собственный
HTTP-пул; при внедрении AsyncClient его жизненным циклом управляет вызывающий код.
"""

import asyncio
import copy
import json
from decimal import Decimal
from typing import Protocol

import httpx
from jsonschema import ValidationError
from jsonschema.validators import validator_for

URL = "https://openrouter.ai/api/v1/chat/completions"


class LLMError(Exception):
    """Сообщение безопасно показывать пользователю; ответ провайдера не включается."""


class LLMFormatError(LLMError):
    pass


class LLMAuthError(LLMError):
    pass


class LLMServiceError(LLMError):
    pass


class LLM(Protocol):
    async def complete_json(
        self, system: str, user: str, schema_name: str, schema: dict
    ) -> dict: ...
    async def chat(self, messages: list[dict], tools: list[dict]) -> dict: ...


def _reject_constant(value):
    raise ValueError("Недопустимое числовое значение JSON")


def _json_object(text: str) -> dict:
    data = json.loads(text, parse_float=Decimal, parse_constant=_reject_constant)
    if not isinstance(data, dict):
        raise ValueError("Ожидался объект JSON")
    return data


class OpenRouterLLM:
    def __init__(self, api_key: str, model: str, http: httpx.AsyncClient | None = None):
        if not api_key.strip():
            raise LLMAuthError("Не задан ключ OpenRouter. Укажите его в настройках.")
        if not model.strip():
            raise ValueError("Не задана модель OpenRouter")
        self._api_key = api_key
        self.model = model
        self._owns_http = http is None
        self._http = (
            http if http is not None else httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10))
        )

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.aclose()

    async def aclose(self):
        if self._owns_http:
            await self._http.aclose()

    @staticmethod
    def _delay(response: httpx.Response | None, attempt: int) -> float:
        try:
            seconds = float(response.headers.get("Retry-After", "")) if response else -1
            if 0 <= seconds <= 30:
                return seconds
        except ValueError:
            pass
        return float(2**attempt)

    async def _request(self, body: dict) -> dict:
        for attempt in range(3):
            response = None
            try:
                response = await self._http.post(
                    URL,
                    json={"model": self.model, **body},
                    headers={"Authorization": f"Bearer {self._api_key}"},
                )
            except httpx.RequestError:
                if attempt < 2:
                    await asyncio.sleep(self._delay(None, attempt))
                    continue
                raise LLMServiceError(
                    "Не удалось связаться с OpenRouter. Повторите позже."
                ) from None
            status = response.status_code
            try:
                payload = response.json()
            except ValueError:
                payload = None
            if (
                status < 400
                and isinstance(payload, dict)
                and isinstance(payload.get("error"), dict)
            ):
                # OpenRouter может сообщить ошибку провайдера и в HTTP 200.
                try:
                    status = int(payload["error"].get("code", 500))
                except (TypeError, ValueError):
                    status = 500
            if status in (401, 403):
                raise LLMAuthError("Ключ OpenRouter недействителен")
            if status == 402:
                raise LLMServiceError("Недостаточно средств OpenRouter. Проверьте баланс и лимиты.")
            if status == 429 or status >= 500:
                if attempt < 2:
                    await asyncio.sleep(self._delay(response, attempt))
                    continue
                raise LLMServiceError(
                    "OpenRouter временно недоступен или превышен лимит запросов. Повторите позже."
                )
            if status >= 400:
                raise LLMServiceError(
                    "OpenRouter отклонил запрос. Проверьте модель и её поддержку "
                    "JSON-схем и инструментов."
                )
            try:
                choice = payload["choices"][0]
                message = choice["message"]
                if (
                    choice.get("finish_reason") in ("length", "error", "content_filter")
                    or not isinstance(message, dict)
                    or message.get("role") != "assistant"
                    or message.get("refusal")
                ):
                    raise ValueError
                return message
            except (KeyError, IndexError, TypeError, ValueError):
                raise LLMFormatError(
                    "OpenRouter вернул неполный ответ или ответ неверного формата"
                ) from None
        raise AssertionError("Исчерпаны попытки запроса")

    async def complete_json(self, system: str, user: str, schema_name: str, schema: dict) -> dict:
        validator_class = validator_for(schema)
        validator_class.check_schema(schema)
        validator = validator_class(schema)
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        for attempt in range(2):
            try:
                message = await self._request(
                    {
                        "messages": messages,
                        "provider": {"require_parameters": True},
                        "response_format": {
                            "type": "json_schema",
                            "json_schema": {
                                "name": schema_name,
                                "schema": schema,
                                "strict": True,
                            },
                        },
                    }
                )
                data = _json_object(message["content"])
                validator.validate(data)
                return data
            except (LLMFormatError, KeyError, TypeError, ValueError, ValidationError):
                if attempt:
                    raise LLMFormatError(
                        "OpenRouter дважды вернул ответ, не соответствующий JSON-схеме"
                    ) from None
                messages.append(
                    {
                        "role": "user",
                        "content": "Ответ не является корректным JSON по схеме, повтори. "
                        "Верни только полный объект JSON без пояснений.",
                    }
                )
        raise AssertionError("Исчерпаны попытки исправления формата")

    async def chat(self, messages: list[dict], tools: list[dict]) -> dict:
        request = {"messages": copy.deepcopy(messages)}
        if tools:
            request.update(tools=tools, tool_choice="auto", provider={"require_parameters": True})
        message = await self._request(request)
        try:
            calls = message.get("tool_calls", [])
            if calls is None:
                calls = []
            if not isinstance(calls, list):
                raise ValueError
            if not calls and not isinstance(message.get("content"), str):
                raise ValueError
            names = {tool["function"]["name"] for tool in tools}
            ids = set()
            for call in calls:
                function = call["function"]
                if (
                    call["type"] != "function"
                    or not isinstance(call["id"], str)
                    or not call["id"]
                    or call["id"] in ids
                    or function["name"] not in names
                ):
                    raise ValueError
                ids.add(call["id"])
                _json_object(function["arguments"])
        except (KeyError, TypeError, ValueError):
            raise LLMFormatError("OpenRouter вернул некорректный вызов инструмента") from None
        return message
