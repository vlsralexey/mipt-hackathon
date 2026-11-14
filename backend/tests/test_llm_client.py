import json
from decimal import Decimal
from unittest.mock import AsyncMock

import httpx
import pytest
from fakes import FakeLLM

from app.llm.client import LLMAuthError, LLMFormatError, LLMServiceError, OpenRouterLLM

SCHEMA = {
    "type": "object",
    "properties": {"a": {"type": "integer"}},
    "required": ["a"],
    "additionalProperties": False,
}
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_offer",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        },
    }
]


def completion(content=None, **message):
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": content, **message},
                "finish_reason": "stop",
            }
        ]
    }


def mock_client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def sleep(monkeypatch):
    sleeper = AsyncMock()
    monkeypatch.setattr("app.llm.client.asyncio.sleep", sleeper)
    return sleeper


async def test_complete_json_sends_schema_and_headers():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=completion('{"a": 1}'))

    async with mock_client(handler) as http:
        async with OpenRouterLLM("secret", "model", http) as llm:
            assert await llm.complete_json("s", "u", "example", SCHEMA) == {"a": 1}
        assert not http.is_closed  # внедрённый пул не закрывается клиентом LLM
    request = requests[0]
    assert str(request.url) == "https://openrouter.ai/api/v1/chat/completions"
    assert request.headers["Authorization"] == "Bearer secret"
    body = json.loads(request.content)
    assert body["model"] == "model" and body["provider"]["require_parameters"]
    assert body["response_format"]["json_schema"] == {
        "name": "example",
        "schema": SCHEMA,
        "strict": True,
    }


@pytest.mark.parametrize(
    "bad", ["not json", '{"a":"wrong"}', "[]", '{"a":1,"extra":2}', '{"a":NaN}']
)
async def test_bad_json_or_schema_retries_once(bad):
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        content = bad if len(requests) == 1 else '{"a":2}'
        return httpx.Response(200, json=completion(content))

    async with mock_client(handler) as http:
        llm = OpenRouterLLM("k", "m", http)
        assert await llm.complete_json("s", "u", "x", SCHEMA) == {"a": 2}
    assert len(requests) == 2 and "повтори" in requests[1]["messages"][-1]["content"]


@pytest.mark.parametrize(
    "payload", [completion("bad"), {"choices": []}, {"choices": [{"message": None}]}]
)
async def test_format_retry_is_bounded(payload):
    count = 0

    def handler(request):
        nonlocal count
        count += 1
        return httpx.Response(200, json=payload)

    async with mock_client(handler) as http:
        with pytest.raises(LLMFormatError):
            await OpenRouterLLM("k", "m", http).complete_json("s", "u", "x", SCHEMA)
    assert count == 2


async def test_decimal_response_is_exact():
    async with mock_client(
        lambda r: httpx.Response(200, json=completion('{"price":123.123456789123456789}'))
    ) as http:
        result = await OpenRouterLLM("k", "m", http).complete_json(
            "s", "u", "x", {"type": "object"}
        )
        assert result["price"] == Decimal("123.123456789123456789")


@pytest.mark.parametrize("status", [401, 403])
async def test_auth_does_not_retry_or_expose_secret(status):
    count = 0

    def handler(request):
        nonlocal count
        count += 1
        return httpx.Response(status, json={"error": {"message": "secret token"}})

    async with mock_client(handler) as http:
        with pytest.raises(LLMAuthError, match="недействителен") as error:
            await OpenRouterLLM("secret", "m", http).complete_json("s", "u", "x", SCHEMA)
    assert count == 1 and "secret" not in str(error.value)


async def test_provider_error_inside_success_response():
    async with mock_client(
        lambda r: httpx.Response(200, json={"error": {"code": 401, "message": "bad"}})
    ) as http:
        with pytest.raises(LLMAuthError):
            await OpenRouterLLM("k", "m", http).chat([], [])


@pytest.mark.parametrize("status", [429, 500, 503])
async def test_transient_retries_respect_retry_after(status, sleep):
    count = 0

    def handler(request):
        nonlocal count
        count += 1
        if count == 1:
            return httpx.Response(status, headers={"Retry-After": "3"})
        return httpx.Response(200, json=completion("Готово"))

    async with mock_client(handler) as http:
        assert (await OpenRouterLLM("k", "m", http).chat([], []))["content"] == "Готово"
    assert count == 2
    sleep.assert_awaited_once_with(3)


async def test_transport_retries_are_bounded(sleep):
    count = 0

    def handler(request):
        nonlocal count
        count += 1
        raise httpx.ReadTimeout("sensitive upstream error", request=request)

    async with mock_client(handler) as http:
        with pytest.raises(LLMServiceError, match="связаться") as error:
            await OpenRouterLLM("k", "m", http).chat([], [])
    assert count == 3 and "sensitive" not in str(error.value)
    assert [c.args[0] for c in sleep.await_args_list] == [1, 2]


@pytest.mark.parametrize(
    "status,expected", [(400, "отклонил"), (402, "средств"), (429, "лимит"), (503, "недоступен")]
)
async def test_service_errors(status, expected, sleep):
    async with mock_client(lambda r: httpx.Response(status)) as http:
        with pytest.raises(LLMServiceError, match=expected):
            await OpenRouterLLM("k", "m", http).chat([], [])


async def test_chat_tools_and_input_not_mutated():
    calls = [
        {
            "id": "call1",
            "type": "function",
            "function": {"name": "get_offer", "arguments": '{"id":"o1"}'},
        }
    ]
    messages = [{"role": "user", "content": "Покажи предложение"}]
    async with mock_client(
        lambda r: httpx.Response(200, json=completion(tool_calls=calls))
    ) as http:
        output = await OpenRouterLLM("k", "m", http).chat(messages, TOOLS)
    assert output["tool_calls"] == calls
    assert len(messages) == 1


@pytest.mark.parametrize(
    "call",
    [
        {"id": "1", "type": "function", "function": {"name": "get_offer", "arguments": "bad"}},
        {"id": "1", "type": "function", "function": {"name": "unknown", "arguments": "{}"}},
        {"id": "", "type": "function", "function": {"name": "get_offer", "arguments": "{}"}},
    ],
)
async def test_malformed_tool_call(call):
    async with mock_client(
        lambda r: httpx.Response(200, json=completion(tool_calls=[call]))
    ) as http:
        with pytest.raises(LLMFormatError):
            await OpenRouterLLM("k", "m", http).chat([], TOOLS)


async def test_owned_client_is_closed():
    llm = OpenRouterLLM("k", "m")
    await llm.aclose()
    assert llm._http.is_closed


def test_empty_settings_fail_before_request():
    with pytest.raises(LLMAuthError):
        OpenRouterLLM("", "m")
    with pytest.raises(ValueError):
        OpenRouterLLM("k", "")


async def test_fake_llm_sequence_callable_and_calls():
    fake = FakeLLM(
        json_responses=[{"a": 1}], chat_responses=[{"role": "assistant", "content": "x"}]
    )
    assert await fake.complete_json("s", "u", "x", {}) == {"a": 1}
    assert (await fake.chat([], []))["content"] == "x"
    assert len(fake.calls) == 2
    fake = FakeLLM(json_responses=lambda s, u, n: {"name": n})
    assert await fake.complete_json("s", "u", "named", {}) == {"name": "named"}


async def test_chat_allows_null_tool_calls_on_text_reply():
    async with mock_client(
        lambda r: httpx.Response(200, json=completion("Текст", tool_calls=None))
    ) as http:
        assert (await OpenRouterLLM("k", "m", http).chat([], TOOLS))["content"] == "Текст"
