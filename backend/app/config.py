"""Настройки процесса; методические правила добавляются на этапе 1."""

from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = Path("data")
    config_dir: Path | None = None
    openrouter_api_key: SecretStr | None = None
    openrouter_model: str = ""

    @property
    def effective_config_dir(self) -> Path:
        return self.config_dir if self.config_dir is not None else self.data_dir / "config"

    @property
    def database_path(self) -> Path:
        return self.data_dir / "nmck.sqlite3"

    def prepare_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.effective_config_dir.mkdir(parents=True, exist_ok=True)
