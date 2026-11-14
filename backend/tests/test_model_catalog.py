import httpx
import pytest

from app.api.routes import get_catalog_http
from app.config import Settings
from app.llm.catalog import URL
from app.main import create_app


def model(id, name, *, inputs=None, outputs=None, **extra):
    return {
        "id": id,
        "name": name,
        "architecture": {
            "input_modalities": inputs if inputs is not None else ["text"],
            "output_modalities": outputs if outputs is not None else ["text"],
        },
        **extra,
    }


async def request_catalog(tmp_path, handler):
    settings = Settings(_env_file=None, data_dir=tmp_path, openrouter_api_key=None)
    app = create_app(settings)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:

        async def catalog_http():
            yield upstream

        app.dependency_overrides[get_catalog_http] = catalog_http
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                return await client.get("/api/settings/models")


async def test_catalog_without_key_filters_sorts_and_deduplicates(tmp_path):
    def handler(request):
        assert str(request.url) == URL
        assert "authorization" not in request.headers
        return httpx.Response(
            200,
            json={
                "data": [
                    model("z/model", "Zulu", pricing={"prompt": "0.01"}),
                    model("a/model", "alpha", inputs=["text", "image"]),
                    model("z/model", "Zulu"),
                    model("image/model", "Image", outputs=["image"]),
                    model("audio/model", "Audio", inputs=["audio"]),
                    model("embed/model", "Embedding", outputs=["embeddings"]),
                    model("responses/model", "Responses", endpoints=["/api/v1/responses"]),
                    model("chat/model", "Chat", endpoints=["/api/v1/chat/completions"]),
                ]
            },
        )

    response = await request_catalog(tmp_path, handler)
    assert response.status_code == 200
    assert response.json() == [
        {"id": "a/model", "name": "alpha"},
        {"id": "chat/model", "name": "Chat"},
        {"id": "z/model", "name": "Zulu"},
    ]


@pytest.mark.parametrize(
    "upstream",
    [
        httpx.Response(503, text="secret provider error"),
        httpx.Response(429, json={"error": "secret provider error"}),
        httpx.Response(200, text="not-json"),
        httpx.Response(200, json={"error": "secret provider error"}),
        httpx.Response(200, json={"data": [{"id": "x"}]}),
    ],
)
async def test_bad_catalog_is_safe_502(tmp_path, upstream):
    response = await request_catalog(tmp_path, lambda _: upstream)
    assert response.status_code == 502
    assert "Не удалось загрузить модели OpenRouter" in response.json()["detail"]
    assert "secret" not in response.text


async def test_catalog_timeout_is_safe_502(tmp_path):
    def handler(request):
        raise httpx.ReadTimeout("secret transport error", request=request)

    response = await request_catalog(tmp_path, handler)
    assert response.status_code == 502
    assert "secret" not in response.text


async def test_empty_catalog(tmp_path):
    response = await request_catalog(tmp_path, lambda _: httpx.Response(200, json={"data": []}))
    assert response.status_code == 200
    assert response.json() == []
