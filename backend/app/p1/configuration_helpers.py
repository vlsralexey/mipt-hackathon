"""Чистое применение локальных настроек без сети и хранилища."""

import copy
import json
from decimal import Decimal
from urllib.parse import urlsplit

from app.config import Rules

LOCAL_RULES = {
    "min_prices",
    "cv_threshold",
    "iqr_k",
    "iqr_min_n",
    "median_max_deviation",
    "vat_rate",
    "indexation_enabled",
    "index_after_months",
    "level2_trigger_min_prices",
    "level2_on_heterogeneous",
    "eis_years",
}
TITLES = {
    "min_prices": "Минимум цен",
    "cv_threshold": "Порог разброса (CV)",
    "iqr_k": "Множитель межквартильного размаха",
    "iqr_min_n": "Минимум цен для IQR",
    "median_max_deviation": "Допустимое отклонение от медианы",
    "vat_rate": "Ставка НДС",
    "indexation_enabled": "Индексация",
    "index_after_months": "Индексировать старше, мес.",
    "level2_trigger_min_prices": "Подключать уровень 2 при числе цен меньше",
    "level2_on_heterogeneous": "Уровень 2 при неоднородной выборке",
    "eis_years": "Глубина ЕИС, лет",
    "spread_hint_min_gap": "Порог подсказки о разбросе",
    "marketplace_hosts": "Маркетплейсы",
    "methodology_note": "Методика",
    "max_pages_per_source": "Страниц на источник",
    "page_text_limit": "Символов со страницы",
}
PERCENT = {"cv_threshold", "median_max_deviation", "vat_rate", "spread_hint_min_gap"}
SOURCE_FIELDS = {
    "enabled",
    "level",
    "params",
    "sites",
    "delivery",
    "site_delivery",
    "vat_default",
    "vat_note",
}


def display(key, value):
    if value is None:
        return "Не задано"
    if isinstance(value, bool):
        return "Да" if value else "Нет"
    if key.split(".")[-1] in PERCENT:
        percent = format((Decimal(str(value)) * 100).normalize(), "f")
        return f"{percent} %".replace(".", ",")
    if isinstance(value, list):
        return ", ".join(str(item) for item in value) or "Список пуст"
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return str(value).replace(".", ",") if isinstance(value, Decimal) else str(value)


def ordered(edits):
    return sorted((e for e in edits if e.status == "active"), key=lambda e: e.seq)


def effective_snapshot(snapshot, edits):
    result = snapshot.model_copy(deep=True)
    data = result.rules.model_dump(mode="json")
    for edit in ordered(edits):
        if edit.kind == "rebase_settings":
            data = copy.deepcopy(edit.payload.rules)
            result.cpi = copy.deepcopy(edit.payload.cpi)
    # Локальные правила остаются поверх новой базы независимо от порядка rebase.
    for edit in ordered(edits):
        if edit.kind == "local_setting" and edit.payload.key.startswith("rules."):
            key = edit.payload.key.split(".", 1)[1]
            if key not in LOCAL_RULES:
                raise ValueError("Правило нельзя менять локально")
            data[key] = edit.payload.value
    result.rules = Rules.model_validate(data)
    return result


def effective_sources(sources, edits):
    result = {s.id: s.model_copy(deep=True) for s in sources}
    for edit in ordered(edits):
        if edit.kind != "local_setting" or not edit.payload.key.startswith("sources."):
            continue
        _, sid, field = edit.payload.key.split(".")
        if sid not in result:
            continue
        if field == "enabled":
            result[sid].enabled = edit.payload.value
        elif field == "sites":
            result[sid].params["sites"] = list(edit.payload.value)
    return list(result.values())


def source_disabled(offer, edits):
    enabled, sites = True, None
    for edit in ordered(edits):
        if edit.kind != "local_setting":
            continue
        if edit.payload.key == f"sources.{offer.source_id}.enabled":
            enabled = edit.payload.value
        if edit.payload.key == f"sources.{offer.source_id}.sites":
            sites = edit.payload.value
    host = (urlsplit(str(offer.url)).hostname or "").lower().removeprefix("www.")
    return not enabled or (
        sites is not None and not any(host == s or host.endswith("." + s) for s in sites)
    )


def local_setting_descriptions(snapshot, edits):
    current = effective_snapshot(snapshot, edits)
    notes = []
    for key in sorted(LOCAL_RULES):
        before, after = getattr(snapshot.rules, key), getattr(current.rules, key)
        if before != after:
            notes.append(f"{TITLES[key]}: {display(key, after)} (база {display(key, before)})")
    latest = {}
    for edit in ordered(edits):
        if edit.kind == "local_setting" and edit.payload.key.startswith("sources."):
            latest[edit.payload.key] = edit
    notes.extend(f"{key}: {display(key, edit.payload.value)}" for key, edit in latest.items())
    return notes
