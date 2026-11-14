from pathlib import Path

from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app


async def test_startup_without_openrouter_key(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    settings = Settings(
        _env_file=None,
        data_dir=data_dir,
        config_dir=data_dir / "config",
        openrouter_api_key=None,
    )

    application = create_app(settings)
    async with application.router.lifespan_context(application):
        async with AsyncClient(
            transport=ASGITransport(app=application), base_url="http://testserver"
        ) as client:
            response = await client.get("/api/health")
            assert response.status_code == 200
            assert response.json() == {"status": "ok"}
            assert settings.effective_config_dir.is_dir()
            assert application.state.settings.database_path == data_dir / "nmck.sqlite3"


def test_environment_overrides_dotenv_and_masks_key(tmp_path: Path, monkeypatch) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text("DATA_DIR=from-dotenv\nOPENROUTER_MODEL=from-dotenv\n", encoding="utf-8")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "runtime-data"))
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "custom-config"))
    monkeypatch.setenv("OPENROUTER_MODEL", "test-model")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-secret-do-not-print")

    settings = Settings(_env_file=dotenv)

    assert settings.data_dir == tmp_path / "runtime-data"
    assert settings.effective_config_dir == tmp_path / "custom-config"
    assert settings.openrouter_model == "test-model"
    assert "test-secret-do-not-print" not in repr(settings)
    assert "test-secret-do-not-print" not in settings.model_dump_json()
