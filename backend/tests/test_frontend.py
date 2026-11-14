from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app


@pytest.mark.parametrize("with_frontend", [True, False])
async def test_frontend_routes_assets_and_api(tmp_path: Path, with_frontend: bool):
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "index.html").write_text("<html>НМЦК</html>", encoding="utf-8")
    (frontend / "assets").mkdir()
    (frontend / "assets" / "app.js").write_text("console.log('НМЦК')", encoding="utf-8")
    (tmp_path / "private.txt").write_text("secret", encoding="utf-8")
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "data",
        frontend_dir=frontend if with_frontend else None,
        openrouter_api_key=None,
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            for path in ("/", "/new", "/settings", "/p/p_123"):
                response = await client.get(path)
                assert response.status_code == (200 if with_frontend else 404)
                if with_frontend:
                    assert response.text == "<html>НМЦК</html>"
                    assert response.headers["cache-control"] == "no-cache"
            response = await client.get("/assets/app.js")
            assert response.status_code == (200 if with_frontend else 404)
            if with_frontend:
                assert "javascript" in response.headers["content-type"]
            for path in ("/api/missing", "/assets/missing.js", "/%2e%2e/private.txt"):
                response = await client.get(path)
                assert response.status_code == 404
                assert response.json() == {"detail": "Адрес не найден"}
            assert (await client.get("/api/health")).json() == {"status": "ok"}
            assert (await client.get("/api/procurements")).json() == []
