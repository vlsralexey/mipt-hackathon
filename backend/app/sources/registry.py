import httpx

from app.config import SourceConfig
from app.sources.base import SourceAdapter
from app.sources.eis import EisSource
from app.sources.web import WebSearch, WebSource


def build_adapters(
    sources: list[SourceConfig],
    search: WebSearch,
    http: httpx.AsyncClient,
    local_settings: dict[str, dict] | None = None,
    fetcher=None,
) -> dict[int, list[SourceAdapter]]:
    """Локальные enabled/sites накладываются на копии общего конфига."""
    result: dict[int, list[SourceAdapter]] = {1: [], 2: []}
    unknown = set(local_settings or {}) - {s.id for s in sources}
    if unknown:
        raise ValueError("Неизвестный локальный источник")
    for source in sources:
        data = source.model_dump()
        local = (local_settings or {}).get(source.id, {})
        if set(local) - {"enabled", "sites"}:
            raise ValueError("Неизвестная локальная настройка источника")
        if "enabled" in local:
            data["enabled"] = local["enabled"]
        if "sites" in local:
            sites = local["sites"]
            if not isinstance(sites, list) or any(not isinstance(s, str) or not s for s in sites):
                raise ValueError("Сайты должны быть списком доменов")
            data["params"]["sites"] = sites
        cfg = SourceConfig.model_validate(data)
        if cfg.enabled:
            adapter = (
                EisSource(cfg, http)
                if cfg.type == "eis"
                else WebSource(cfg, search, http, fetcher=fetcher)
            )
            result[cfg.level].append(adapter)
    return result
