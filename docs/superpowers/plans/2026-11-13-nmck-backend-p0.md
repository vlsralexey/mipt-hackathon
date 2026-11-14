# Бэкенд агента НМЦК (P0) — план реализации

> **Актуальная точка входа:** [маршрут бэкенда](../../backend-roadmap.md).
> Этот документ содержит подробные задачи. Порядок этапов и состояние работ —
> в маршруте; API-контракт и спека правок имеют приоритет над старыми интерфейсами
> ниже. Подготовка репозитория вынесена в отдельный этап 0.

**Goal:** Локальный бэкенд, который по ТЗ ищет предложения в открытых источниках (каскад уровней), сопоставляет, нормализует, считает НМЦК и отдаёт структурированный отчёт через API, CLI и DOCX, запускаясь через `docker compose up`.

**Architecture:** FastAPI-приложение на Python. Детерминированный конвейер (разбор ТЗ → поиск по адаптерам → извлечение → сопоставление → нормализация → расчёт) с LLM (OpenRouter) только на шагах разбора, извлечения и сравнения характеристик. Все числа считает код на `Decimal`. Состояние — SQLite в Docker-томе, каждый пересчёт создаёт новую версию отчёта. Чат-агент меняет данные через инструменты и запускает пересчёт.

**Tech Stack:** Python 3.12, FastAPI, uvicorn, pydantic v2, httpx, sse-starlette, python-docx, pypdf, PyYAML, selectolax, pytest, pytest-asyncio (`asyncio_mode=auto`), respx.

**Spec:** `docs/superpowers/specs/2026-11-13-nmck-agent-design.md`

**Вне этого плана:** фронтенд (отдельный план после макетов, работает по контракту из Task 12), P1 — маркетплейсы через Playwright и живое окно, правка конфига агентом, UI версий (отдельный план).

## Порядок выполнения

Ветка: `agents/<тема>` от актуального `dev`, согласно `AGENTS.md`. Напрямую в
`dev` не коммитить. Каждая сессия заканчивается рабочим протестированным
состоянием, коммитами и обновлением маршрута. Субагенты необязательны.

| Сессия | Задачи | Результат | Нужно заранее |
|---|---|---|---|
| 1 | 1–5 | Каркас, Docker, нормализация и расчёт, извлечение текста ТЗ, клиент OpenRouter | — (всё на тестах) |
| 2 | 6–10 | Разбор ТЗ, источники (ЕИС, веб), сопоставление, каскад | Ключ OpenRouter; HTML страниц ЕИС для фикстур Task 8 — выдача и 4 вкладки контракта (сохранить из обычного браузера, если ЕИС не открывается из окружения агента) |
| 3 | 11–15 | Хранилище, API + `docs/api.md`, чат-агент, DOCX, CLI, README, живые прогоны | Ключ OpenRouter |

Запуск сессии:

```
Прочитай AGENTS.md и docs/backend-roadmap.md и выполни задачи N–M из плана
docs/superpowers/plans/2026-11-13-nmck-backend-p0.md (спека: docs/superpowers/specs/2026-11-13-nmck-agent-design.md).
Учитывай docs/api.md и docs/superpowers/specs/2026-11-14-report-edits-design.md.
Работаем в ветке agents/<тема>. После задачи M обнови маршрут и дай сводку.
```

## Global Constraints

- LLM-провайдер — только OpenRouter; ключ из настроек (БД), запасной вариант — env `OPENROUTER_API_KEY`; модель — env `OPENROUTER_MODEL` / настройки. Идентификатор модели по умолчанию сверить на openrouter.ai/models при реализации.
- LLM извлекает и сравнивает; нормализация, выбросы, статистика, НМЦК — только код, на `Decimal`, деньги округляются до копеек `ROUND_HALF_UP`.
- Метод сопоставимых рыночных цен: НМЦК за единицу = среднее по включённым ценам; СКО с n−1; CV = СКО / среднее; однородность при CV ≤ 0,33; минимум 3 цены.
- Правило выбросов: n ≥ 5 — вне [Q1 − 1,5·IQR; Q3 + 1,5·IQR] (`statistics.quantiles(..., n=4, method="inclusive")`); n < 5 — |ц − медиана| / медиана > 0,5.
- Если после исключения цен < 3 → статус `insufficient`; если CV > 0,33 → `heterogeneous`. В обоих случаях `unit_price = None`, среднее идёт в `reference_price`.
- Каскад по позиции: уровень 2 подключается, если после исключения выбросов на уровне 1 осталось < 3 включённых цен **или** CV > порога (`rules.level2_on_heterogeneous`); затем расчёт по объединённой выборке.
- Расчётная цена предложения = `round(цена за ед. ТЗ × vat.factor × indexation.factor, 2) + delivery.added_per_unit`. Каждый множитель хранится в `OfferEntry` со своим основанием (`note`) и показывается в отчёте.
- НДС: всё приводится к виду «с НДС». Решает код `resolve_vat` (Task 3): `included`/`exempt` — без поправки; `excluded` — × (1 + ставка со страницы, иначе `rules.vat_rate`); `unknown` на странице → `SourceConfig.vat_default`; если и там `unknown` — без поправки, предложение остаётся в выборке, в отчёте предупреждение. LLM ставку и статус не угадывает.
- Индексация: цена, у которой `price_date` старше `rules.index_after_months` месяцев от `Report.calc_date`, умножается на `k = (100 + Σ(ИПЦ_m − 100)) / 100` по месяцам от следующего за месяцем цены до месяца перед расчётом (приказ № 567, п. 3.18 — сверить). ИПЦ — из `backend/config/cpi.yaml`. Без `price_date` цена считается текущей. `calc_date` фиксируется при первом прогоне и не меняется при пересчётах версии.
- Одна цена от поставщика: после сопоставления и приведения, до выбросов. Ключ поставщика — ИНН → нормализованное название → хост URL (кроме `rules.marketplace_hosts`); без ключа предложение независимо. Остаётся самая свежая цена (при равенстве — меньшая), остальные → `same_supplier`.
- Порядок шагов расчёта фиксирован: приведение → отбор по поставщику → выбросы → статистика → (при `heterogeneous`) подсказки о причине разброса. Автоматического сужения выборки под CV нет.
- Все пороги — в `backend/config/rules.yaml`, источники — в `backend/config/sources.yaml`; код их не хардкодит.
- Доставка — условие предложения, а не сумма: система никогда не идёт в корзину/оформление заказа. LLM берёт со страницы только написанное там (включена / порог бесплатной доставки / явная сумма); решение принимает код `resolve_delivery` (Task 3): страница важнее условий источника из `sources.yaml`; порог сравнивается с суммой заказа по ТЗ; явная сумма делится на количество по ТЗ; иначе `unknown` без поправки. Надбавок «на глаз» нет.
- Отказ источника (сеть, вёрстка, пустой ответ) никогда не обрывает прогон: фиксируется в `SourceRun.status`.
- Каждое предложение в отчёте имеет `url` и `retrieved_at`.
- Сценарий без человека: у каждого уточняющего вопроса есть `default_answer`, прогон идёт с ним сразу; ответ пользователя пересчитывает позицию и создаёт новую версию.
- Тексты для пользователя (статусы, причины, предупреждения, ошибки API) — на русском.

## Review Focus

1. **ТЗ, где всё в таблицах** (все три примера) — извлечение текста обязано брать ячейки таблиц, иначе позиции теряются. Тест в Task 4 на реальном `docs/ТЗ поставка бумаги.docx`.
2. **Цены в «живом» формате** (`1 290,50 ₽`, неразрывные пробелы, `руб.`, «по запросу») — парсится или предложение уходит в исключённые с `insufficient_data`, без падения. Тест в Task 2.
3. **Нет/неверный ключ OpenRouter** — API отвечает 400 с понятным текстом, прогон не стартует молча. Тест в Task 12.
4. **Все источники недоступны / нет сети** — отчёт строится со статусом `insufficient` и статусами источников `unavailable`, исключения не всплывают. Тест в Task 10.
5. **LLM вернула битый JSON** — один повтор, затем `LLMFormatError`, которое на уровне страницы превращается в пропуск страницы, а не в падение прогона. Тесты в Task 5 и Task 10.
6. **Доставка за заказ, а не за единицу** — сумма доставки со страницы делится на количество по ТЗ, а не на фасовку предложения (500 ₽ на заказ 2 500 пачек = +0,20 ₽/пачка, а не +100 ₽). Тест в Task 3.
7. **Двойное начисление НДС** — `exempt` («НДС не облагается», УСН) и `included` никогда не умножаются; поправка только при явном «без НДС»/«+ НДС» на странице. Тест в Task 3.
8. **Индексация без данных** — нет месяца в `cpi.yaml` → считается по имеющимся месяцам с пометкой в `note`, без падения и без выдуманных индексов. Числа в `cpi.yaml` — только с сайта Росстата. Тест в Task 3.
9. **Отбор по поставщику не съедает маркетплейс** — десять продавцов Ozon без названия продавца остаются десятью предложениями, а не одним. Тест в Task 3.
10. **ЕИС «Без НДС» не облагается сверху** — у источника с `price_final` поправка ×1,22 невозможна, даже если LLM извлекла `excluded`. Тест в Task 3.
11. **ЕИС не теряет подходящие контракты** — нет фильтра по ОКПД2 из ТЗ, единица «пач» = «пачка», характеристики строки берутся со страницы «Все характеристики ТРУ», контракты с неустойками отброшены кодом с причиной в отчёте. Тесты в Task 2 и Task 8.

---

## Структура файлов

```
backend/
  pyproject.toml
  Dockerfile
  config/sources.yaml        # источники: id, name, level, type, enabled, params, условия доставки
  config/rules.yaml          # пороги расчёта и сопоставления, ставка НДС, текст методики
  config/cpi.yaml            # месячные ИПЦ Росстата (% к предыдущему месяцу) для индексации
  app/
    models.py                # доменные модели (контракт отчёта)
    config.py                # Settings (env) + загрузка YAML
    units.py                 # единицы, parse_price, parse_amount
    pipeline/normalize.py    # приведение цены к единице ТЗ, НДС, индексация, доставка
    pipeline/calc.py         # отбор по поставщику, выбросы, статистика, НМЦК, подсказки о разбросе
    pipeline/extract_text.py # docx/pdf/txt → текст
    pipeline/parse_tz.py     # текст ТЗ → позиции + вопросы (LLM)
    pipeline/extract.py      # страница → предложения (LLM)
    pipeline/match.py        # сравнение характеристик (LLM) + решение (код), дубли
    pipeline/research.py     # каскад по позиции, сборка Report
    llm/client.py            # LLM-протокол, OpenRouter-реализация
    llm/prompts.py           # системные промпты
    sources/base.py          # SourceAdapter, CandidatePage, SourceResult
    sources/fetch.py         # HTTP с ретраями, html → текст
    sources/web.py           # веб-поиск OpenRouter + загрузка страниц
    sources/eis.py           # ЕИС: реестр контрактов
    sources/registry.py      # sources.yaml → адаптеры по уровням
    store/repo.py            # SQLite: закупки, сообщения, версии отчёта, настройки
    agent/chat.py            # чат-агент с инструментами
    report/docx_export.py    # Report → DOCX
    api/routes.py            # REST + SSE
    events.py                # шина событий прогона
    main.py                  # FastAPI app
    cli.py                   # python -m app.cli run <tz> --out ...
  tests/ (fakes.py, fixtures/, test_*.py)
docker-compose.yml
.env.example
README.md
docs/architecture.md
docs/api.md
```

---

### Task 1: Каркас, доменные модели, конфиг, Docker

**Files:**
- Create: `backend/pyproject.toml`, `backend/app/models.py`, `backend/app/config.py`, `backend/config/rules.yaml`, `backend/config/sources.yaml`, `backend/app/main.py`, `backend/Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md` (каркас разделов)
- Test: `backend/tests/test_models.py`, `backend/tests/test_config.py`

**Interfaces:**
- Produces (`app/models.py`, все — pydantic `BaseModel`, деньги/количества — `Decimal`):
  - `Characteristic(name: str, value: str, unit: str | None, essential: bool)`
  - `Basis(unit: str, per_tz_unit: Decimal)` — единица сравнения и сколько её в одной единице ТЗ
  - `Position(index: int, name: str, unit: str, quantity: Decimal, okpd2: str | None, characteristics: list[Characteristic], basis: Basis, search_terms: list[str] = [])` — `okpd2` — как в ТЗ, только для отчёта: в фильтр поиска не идёт (в ЕИС ОКПД2 у той же бумаги другой, спека 5.4.1); `search_terms` — короткие поисковые запросы для реестров (Task 6)
  - `Question(id: str, position_index: int, text: str, default_answer: str, answer: str | None = None)`
  - `Offer(id: str, source_id: str, source_name: str, level: int, url: str, retrieved_at: datetime, title: str, price: Decimal, currency: str = "RUB", amount: Decimal, amount_unit: str, vat: Literal["included","excluded","exempt","unknown"], vat_rate: Decimal | None = None, supplier: str | None = None, supplier_inn: str | None = None, delivery: Literal["included","separate","unknown"], delivery_cost: Decimal | None, delivery_free_from: Decimal | None = None, delivery_note: str | None = None, price_date: date | None, characteristics: dict[str, str])` — все поля доставки — только то, что написано на странице: `included` = доставка бесплатна/включена без условий; `delivery_free_from` = порог бесплатной доставки; `separate` + `delivery_cost` = явная сумма; `delivery_note` = цитата условия со страницы; `vat`: `excluded` = цена без НДС, налог начисляется сверху; `exempt` = «НДС не облагается» (конечная цена); `vat_rate` — ставка со страницы долей (`0.22`), если указана
  - `VatResolution(status: Literal["included","added","exempt","unknown"], factor: Decimal = Decimal(1), note: str)` — решение кода по НДС
  - `IndexResolution(status: Literal["applied","not_needed","no_data"], factor: Decimal = Decimal(1), note: str)` — индексация цены прошлого периода; `note` — период и использованные месяцы
  - `DeliveryResolution(status: Literal["included","added","unknown"], added_per_unit: Decimal = Decimal(0), note: str)` — решение кода по доставке; `note` — человекочитаемое основание («Бесплатно от 5 000 ₽ по условиям Комус; заказ по ТЗ ≈ 725 000 ₽»)
  - `CharComparison(name: str, required: str, offered: str | None, essential: bool, ok: bool | None)`
  - `ExclusionReason = Literal["anomalous_price","incomparable","unit_mismatch","insufficient_data","duplicate","same_supplier","user_excluded"]`
  - `OfferEntry(offer: Offer, base_price: Decimal | None, vat: VatResolution | None, indexation: IndexResolution | None, delivery: DeliveryResolution | None, normalized_price: Decimal | None, comparison: list[CharComparison], reason: str, exclusion: ExclusionReason | None)` — `base_price` = цена за единицу ТЗ до поправок; `normalized_price` = расчётная цена = `round(base_price × vat.factor × indexation.factor, 2) + delivery.added_per_unit`
  - `SkippedPage(url: str, source_id: str, reason: str)` — страница, с которой не удалось извлечь предложение
  - `Stats(n: int, min: Decimal, max: Decimal, mean: Decimal, std: Decimal, cv: Decimal, outlier_rule: str)`
  - `SourceRun(source_id: str, name: str, level: int, queries: list[str], status: Literal["ok","empty","unavailable","error"], error: str | None, found: int, at: datetime)`
  - `PositionReport(position: Position, levels_used: list[int], included: list[OfferEntry], excluded: list[OfferEntry], stats: Stats | None, unit_price: Decimal | None, reference_price: Decimal | None, total: Decimal | None, status: Literal["ok","insufficient","heterogeneous"], assumptions: list[str], skipped_pages: list[SkippedPage], spread_hints: list[str] = [], overrides: dict[str, Literal["include","exclude"]] = {})`
  - `Report(procurement_id: str, version: int, created_at: datetime, calc_date: date, methodology: str, cause: str, positions: list[PositionReport], sources: list[SourceRun], questions: list[Question], delivery_terms: str | None = None, delivery_extras: list[str] = [], total: Decimal | None, warnings: list[str])` — `delivery_terms`/`delivery_extras` — требования ТЗ к поставке (из `ParsedTZ`, Task 6); `calc_date` — дата, на которую индексируются цены; `methodology` — `rules.methodology_note`
- Produces (`app/config.py`): `Rules` (pydantic) с полями и значениями по умолчанию `min_prices=3, cv_threshold=Decimal("0.33"), iqr_k=Decimal("1.5"), iqr_min_n=5, median_max_deviation=Decimal("0.5"), level2_trigger_min_prices=3, level2_on_heterogeneous=True, vat_rate=Decimal("0.22"), indexation_enabled=True, index_after_months=6, spread_hint_min_gap=Decimal("0.15"), marketplace_hosts=["market.yandex.ru","ozon.ru","wildberries.ru"], methodology_note="Метод сопоставимых рыночных цен (анализа рынка). Формулы — по аналогии с Методическими рекомендациями, утверждёнными приказом Минэкономразвития России от 02.10.2013 № 567 (обязательны для закупок по 44-ФЗ; при закупках по 223-ФЗ применяется положение о закупке заказчика).", eis_years=3, max_pages_per_source=8, page_text_limit=15000`; `DeliveryPolicy(included: bool = False, free_from: Decimal | None = None, note: str | None = None)` — условия доставки источника для юрлиц в Московской области (заполняются, только если условие действительно действует для МО; `note` — откуда взято); `SourceConfig(id, name, level: int, type: Literal["eis","web"], enabled: bool, params: dict, vat_default: Literal["included","unknown"] = "unknown", vat_note: str | None = None, price_final: bool = False, delivery: DeliveryPolicy = DeliveryPolicy(), site_delivery: dict[str, DeliveryPolicy] = {})` — `site_delivery` по домену для источников с несколькими сайтами; `price_final` — цена источника всегда конечная, НДС сверху не начисляется никогда (ЕИС: «Без НДС» = поставщик не платит налог); `policy_for(cfg: SourceConfig, url: str) -> DeliveryPolicy` — по хосту URL без `www.` из `site_delivery`, иначе `cfg.delivery`; `load_rules(path) -> Rules`; `load_cpi(path) -> dict[str, Decimal]` — ключ `"YYYY-MM"`, значение — ИПЦ в % к предыдущему месяцу (нет файла → пустой словарь); `load_sources(path) -> list[SourceConfig]`; `Settings` (env: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `DATA_DIR=/data`, `CONFIG_DIR`).

- [ ] **Step 1: Написать тесты**

```python
def test_report_roundtrip_keeps_decimals():
    r = make_sample_report()  # хелпер в tests/fakes.py
    again = Report.model_validate_json(r.model_dump_json())
    assert again.positions[0].unit_price == Decimal("290.00")

def test_load_rules_defaults_and_override(tmp_path):
    p = tmp_path / "rules.yaml"; p.write_text("cv_threshold: 0.25\n")
    rules = load_rules(p)
    assert rules.cv_threshold == Decimal("0.25") and rules.min_prices == 3

def test_shipped_sources_yaml_has_both_levels():
    srcs = load_sources(Path("config/sources.yaml"))
    assert {s.level for s in srcs if s.enabled} == {1, 2}

def test_eis_delivery_included_by_default():
    eis = next(s for s in load_sources(Path("config/sources.yaml")) if s.id == "eis")
    assert eis.delivery.included and eis.delivery.note

def test_eis_price_is_final():
    eis = next(s for s in load_sources(Path("config/sources.yaml")) if s.id == "eis")
    assert eis.price_final

def test_eis_and_shops_vat_included_by_default():
    srcs = {s.id: s for s in load_sources(Path("config/sources.yaml"))}
    assert srcs["eis"].vat_default == "included" and srcs["web_shops"].vat_default == "included"
    assert srcs["web_suppliers"].vat_default == "unknown"

def test_load_cpi(tmp_path):
    p = tmp_path / "cpi.yaml"; p.write_text('"2026-05": 100.43\n')
    assert load_cpi(p) == {"2026-05": Decimal("100.43")} and load_cpi(tmp_path / "none.yaml") == {}

def test_policy_for_matches_site_without_www():
    cfg = SourceConfig(id="w", name="w", level=2, type="web", enabled=True, params={},
                       site_delivery={"komus.ru": DeliveryPolicy(free_from=Decimal(5000))})
    assert policy_for(cfg, "https://www.komus.ru/p/1").free_from == Decimal(5000)
    assert policy_for(cfg, "https://ozon.ru/p/1") == cfg.delivery
```

- [ ] **Step 2: `cd backend && pytest -q` — FAIL (нет модулей)**
- [ ] **Step 3: Реализовать модели, конфиг, YAML.** `sources.yaml`: `eis` (level 1, type eis, `delivery: {included: true, note: "Допущение: цена контракта по 44-ФЗ, как правило, включает доставку до заказчика"}`); `web_suppliers` (level 1, type web, `params.query_suffix: "цена производитель дистрибьютор"`); `web_shops` (level 2, type web, `params.sites: [komus.ru, vseinstrumenti.ru, market.yandex.ru, ozon.ru]`, `site_delivery` — для Комус и ВсеИнструменты порог бесплатной доставки юрлицам по МО со страниц условий доставки этих сайтов, `note` = URL страницы условий; если порог не удалось найти или он не для МО — не заполнять, чисел не выдумывать). У `eis` — `vat_default: included`, `vat_note: "Допущение: цена контракта — конечная, включает НДС, если поставщик его платит"`, `price_final: true`; у `web_shops` — `vat_default: included`, `vat_note: "Розничные цены на сайте указаны с НДС"`; у `web_suppliers` — `unknown`. `rules.yaml` — значения по умолчанию из Interfaces; ставку `vat_rate` сверить с действующей на дату реализации. `cpi.yaml` — месячные ИПЦ Росстата (все товары и услуги, РФ, % к предыдущему месяцу) за последние `eis_years` лет плюс запас, в шапке файла — URL страницы Росстата и дата выгрузки; если данные получить не удалось — оставить файл пустым с комментарием, чисел не выдумывать. `main.py` — `FastAPI()` с `GET /api/health → {"status":"ok"}`.
- [ ] **Step 4: Dockerfile + compose.** Образ `python:3.12-slim`, `pip install .`, `CMD uvicorn app.main:app --host 0.0.0.0 --port 8000`. Compose: сервис `backend`, порт `8000:8000`, том `nmck-data:/data`, `env_file: .env`. `.env.example` с `OPENROUTER_API_KEY=`, `OPENROUTER_MODEL=`. README — заголовки разделов из критериев (требования, запуск/остановка, переменные, внешние сервисы, архитектура, use cases), заполняются в Task 15.
- [ ] **Step 5: Проверить:** `pytest -q` — PASS; `docker compose up -d --build && curl -s localhost:8000/api/health` → `{"status":"ok"}`; `docker compose down`.
- [ ] **Step 6: Commit** `feat: каркас бэкенда, модели отчёта, конфиг, Docker`

---

### Task 2: Единицы и разбор цен

**Files:**
- Create: `backend/app/units.py`
- Test: `backend/tests/test_units.py`

**Interfaces:**
- Produces: `parse_price(s: str) -> Decimal` (ValueError, если числа нет); `canonical_unit(u: str) -> str`; `convert(amount: Decimal, from_unit: str, to_unit: str) -> Decimal` (raises `UnitMismatch(ValueError)`).
- Таблица: масса (база мкг): мкг/µg/ug/mcg=1, мг/mg=1000, г/гр/g=10⁶, кг/kg=10⁹; объём (база мл): мл/ml=1, л/l=1000; счётные `шт`(шт./штука/pcs/ед/ед.) — только сами с собой; `пачка` (пачка/пачки/пачек/пач/пач.) — только сама с собой (в ЕИС единица пишется «пач», без синонима все цены ЕИС уйдут в `unit_mismatch`); любые прочие (`пачка`, `упаковка`, `рулон`, `услуга`, `час`, `м2`/`м²`) — равны только сами себе после нормализации (нижний регистр, без точек и пробелов по краям).

- [ ] **Step 1: Тесты**

```python
@pytest.mark.parametrize("s,expected", [
    ("1 290,50 ₽", Decimal("1290.50")), ("12 990 руб.", Decimal("12990")),
    ("1290.5", Decimal("1290.5")), ("от 3 450 ₽", Decimal("3450")), ("15 000", Decimal("15000")),
    ("3 140,80333333333", Decimal("3140.80333333333")),  # цена за ед. в ЕИС бывает с длинной дробью
])
def test_parse_price(s, expected): assert parse_price(s) == expected

def test_parse_price_on_request_raises():
    with pytest.raises(ValueError): parse_price("по запросу")

def test_convert_mass(): assert convert(Decimal("0.05"), "мг", "мкг") == Decimal("50")
def test_convert_alias(): assert convert(Decimal("25"), "µg", "мкг") == Decimal("25")
def test_convert_same_custom_unit(): assert convert(Decimal("5"), "Пачка.", "пачка") == Decimal("5")
def test_convert_eis_pack_alias(): assert convert(Decimal("650"), "пач", "пачка") == Decimal("650")
def test_convert_mismatch():
    with pytest.raises(UnitMismatch): convert(Decimal("1"), "мл", "мкг")
```

- [ ] **Step 2: `pytest tests/test_units.py -q` — FAIL**
- [ ] **Step 3: Реализовать.** `parse_price`: убрать ` `, ` `, пробелы между цифрами, взять первое число, запятую → точка.
- [ ] **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: единицы измерения и разбор цен`

---

### Task 3: Нормализация и расчёт

**Files:**
- Create: `backend/app/pipeline/normalize.py`, `backend/app/pipeline/calc.py`
- Test: `backend/tests/test_normalize.py`, `backend/tests/test_calc.py`

**Interfaces:**
- Consumes: `convert`, `UnitMismatch` (Task 2); `Offer`, `OfferEntry`, `Basis`, `Stats`, `Rules`, `SourceConfig`, `DeliveryPolicy`, `DeliveryResolution`, `VatResolution`, `IndexResolution`.
- Produces:
  - `normalize_price(offer: Offer, basis: Basis) -> Decimal` = `price / convert(amount, amount_unit, basis.unit) * basis.per_tz_unit`, округление до 0.01 — цена товара за единицу ТЗ **без** доставки. Пробрасывает `UnitMismatch`.
  - `resolve_delivery(offer: Offer, policy: DeliveryPolicy, unit_price: Decimal, quantity: Decimal) -> DeliveryResolution` — `order_sum = unit_price × quantity`; правила по порядку, первое сработавшее:
    1. `offer.delivery == "included"` → `included`, основание — страница;
    2. `offer.delivery_free_from` задан и `order_sum ≥` него → `included`, основание — порог со страницы и сумма заказа;
    3. `offer.delivery == "separate"` и `delivery_cost` задан → `added`, `added_per_unit = delivery_cost / quantity` (округл. 0.01) — доставка одна на весь объём по ТЗ;
    4. `policy.included` → `included`, основание — `policy.note`;
    5. `policy.free_from` задан и `order_sum ≥` него → `included`, основание — условия источника и сумма заказа;
    6. иначе → `unknown`, `added_per_unit = 0`, `note` = «Стоимость доставки не указана на странице» (+ `delivery_note`, если есть).
  - `resolve_vat(offer: Offer, vat_default: str, vat_note: str | None, rules: Rules, price_final: bool = False) -> VatResolution` — первое сработавшее:
    1. `offer.vat == "included"` → `included`, factor 1, основание — страница;
    2. `offer.vat == "exempt"` → `exempt`, factor 1, «НДС не облагается — цена конечная»;
    3. `offer.vat == "excluded"` и `price_final` → `exempt`, factor 1, «Цена контракта конечная; «Без НДС» — поставщик не платит НДС»;
    4. `offer.vat == "excluded"` → `added`, `factor = 1 + (offer.vat_rate or rules.vat_rate)`, в `note` — ставка и откуда она (страница / настройки);
    5. `vat_default == "included"` → `included`, основание — `vat_note`;
    6. иначе → `unknown`, factor 1, «НДС на странице не указан».
  - `index_price(price_date: date | None, calc_date: date, cpi: dict[str, Decimal], rules: Rules) -> IndexResolution` — `age = (calc.year − price.year) × 12 + calc.month − price.month`; если `not rules.indexation_enabled`, `price_date is None` или `age ≤ rules.index_after_months` → `not_needed`; иначе месяцы от следующего за месяцем цены до месяца перед `calc_date` включительно: `factor = (100 + Σ(cpi[m] − 100)) / 100` по месяцам, которые есть в `cpi`, округление до 0.0001; в `note` — период, число месяцев и, если каких-то месяцев нет, «нет данных ИПЦ за: …»; если нет ни одного месяца → `no_data`, factor 1.
  - `adjusted_price(base: Decimal, vat: VatResolution, idx: IndexResolution, delivery: DeliveryResolution) -> Decimal` = `round(base × vat.factor × idx.factor, 0.01) + delivery.added_per_unit` — расчётная цена предложения. Порог бесплатной доставки в `resolve_delivery` сравнивается с `base × quantity` (без поправок).
  - `supplier_key(offer: Offer, rules: Rules) -> str | None` — `supplier_inn` (только цифры) → нормализованное `supplier` (casefold, без кавычек и форм ООО/АО/ПАО/ЗАО/ИП, схлопнутые пробелы) → хост URL без `www.`, если `offer.source_id != "eis"` и хост не входит в `rules.marketplace_hosts` → иначе `None`.
  - `pick_per_supplier(entries: list[OfferEntry], rules: Rules) -> tuple[list[OfferEntry], list[tuple[OfferEntry, OfferEntry]]]` — (оставленные, [(отброшенное, оставленное вместо него)]); в группе с одним ключом остаётся запись с самой поздней датой (`price_date`, иначе дата `retrieved_at`), при равенстве — с меньшей `normalized_price`, затем по `offer.id`; записи без ключа остаются все. Порядок оставленных — как на входе.
  - `diagnose_spread(entries: list[OfferEntry], rules: Rules) -> list[str]` — подсказки для неоднородной выборки. Признаки по порядку: источник (`offer.source_id == "eis"` / остальные, подпись «цены ЕИС» / «цены остальных источников»), НДС (`vat.status == "unknown"` / остальные), НДС у поставщика (`vat.status == "exempt"` / остальные, подпись «цены поставщиков без НДС» / «цены с НДС»), индексация (`indexation.status == "applied"` / остальные), доставка (`delivery.status == "unknown"` / остальные). Для признака, где обе группы не пусты: `gap = (hi − lo) / hi` по средним; если `gap ≥ rules.spread_hint_min_gap` → строка «<группа с меньшим средним> в среднем на X % ниже <другой> (N против M предложений)». Сортировка по `gap` по убыванию, не больше 3 строк. Выборку не меняет.
  - `find_outliers(prices: list[Decimal], rules: Rules) -> tuple[set[int], str]` — индексы выбросов и человекочитаемое описание правила.
  - `compute_stats(prices: list[Decimal], rule_text: str) -> Stats` (std с n−1; при n=1 std=0; cv до 0.0001).
  - `CalcResult(stats: Stats | None, unit_price: Decimal | None, reference_price: Decimal | None, status: str)`; `calculate(prices: list[Decimal], rules: Rules) -> CalcResult` — вызывается уже по ценам без выбросов.

- [ ] **Step 1: Тесты**

```python
def test_normalize_paper_pack_of_5():
    assert normalize_price(offer(price="1450", amount="5", unit="пачка"), Basis(unit="пачка", per_tz_unit=Decimal(1))) == Decimal("290.00")

def test_normalize_cytokine_per_10ug():
    assert normalize_price(offer(price="15000", amount="25", unit="мкг"), Basis(unit="мкг", per_tz_unit=Decimal(10))) == Decimal("6000.00")

def test_normalize_mg_to_ug():
    assert normalize_price(offer(price="20000", amount="0.05", unit="мг"), Basis(unit="мкг", per_tz_unit=Decimal(10))) == Decimal("4000.00")

def test_normalize_ignores_delivery():
    o = offer(price="1000", amount="1", unit="шт", delivery="separate", delivery_cost="500")
    assert normalize_price(o, Basis(unit="шт", per_tz_unit=Decimal(1))) == Decimal("1000.00")

def test_delivery_cost_spread_over_tz_quantity():
    o = offer(price="1450", amount="5", unit="пачка", delivery="separate", delivery_cost="500")
    r = resolve_delivery(o, DeliveryPolicy(), D("290.00"), D(2500))
    assert r.status == "added" and r.added_per_unit == D("0.20")

def test_delivery_free_threshold_from_page_met():
    o = offer(price="1450", amount="5", unit="пачка", delivery="unknown", delivery_free_from="5000")
    assert resolve_delivery(o, DeliveryPolicy(), D("290.00"), D(2500)).status == "included"

def test_delivery_free_threshold_from_page_not_met_falls_to_unknown():
    o = offer(price="1450", amount="5", unit="пачка", delivery="unknown", delivery_free_from="5000")
    assert resolve_delivery(o, DeliveryPolicy(), D("290.00"), D(10)).status == "unknown"

def test_delivery_page_beats_source_policy():
    o = offer(price="1000", amount="1", unit="шт", delivery="separate", delivery_cost="300")
    r = resolve_delivery(o, DeliveryPolicy(included=True, note="ЕИС"), D("1000.00"), D(3))
    assert r.status == "added" and r.added_per_unit == D("100.00")

def test_delivery_source_policy_included():
    r = resolve_delivery(offer(price="1000", amount="1", unit="шт"), DeliveryPolicy(included=True, note="ЕИС"), D("1000.00"), D(1))
    assert r.status == "included" and "ЕИС" in r.note

def test_delivery_source_threshold():
    r = resolve_delivery(offer(price="290", amount="1", unit="пачка"), DeliveryPolicy(free_from=D(5000)), D("290.00"), D(2500))
    assert r.status == "included"

def test_delivery_unknown_without_info():
    r = resolve_delivery(offer(price="290", amount="1", unit="пачка"), DeliveryPolicy(), D("290.00"), D(2500))
    assert r.status == "unknown" and r.added_per_unit == 0

def test_outliers_small_n_median_rule():
    idx, _ = find_outliers([D(100), D(105), D(300)], Rules()); assert idx == {2}

def test_outliers_iqr_rule():
    idx, rule = find_outliers([D(98), D(99), D(100), D(101), D(102), D(250)], Rules())
    assert idx == {5} and "IQR" in rule

def test_calculate_ok():
    r = calculate([D(100), D(110), D(90)], Rules())
    assert r.status == "ok" and r.unit_price == D("100.00") and r.stats.std == D(10) and r.stats.cv == D("0.1000")

def test_calculate_insufficient():
    r = calculate([D(100), D(105)], Rules())
    assert r.status == "insufficient" and r.unit_price is None and r.reference_price == D("102.50")

def test_calculate_heterogeneous():
    r = calculate([D(100), D(140), D(60)], Rules())
    assert r.status == "heterogeneous" and r.unit_price is None and r.stats.cv == D("0.4000")

def test_calculate_empty():
    r = calculate([], Rules()); assert r.status == "insufficient" and r.stats is None
```

- [ ] **Step 1a: Тесты поправок, отбора по поставщику и подсказок**

```python
def test_vat_excluded_uses_config_rate():
    v = resolve_vat(offer(price="100", amount="1", unit="шт", vat="excluded"), "unknown", None, Rules())
    assert v.status == "added" and v.factor == D("1.22")

def test_vat_excluded_page_rate_wins():
    v = resolve_vat(offer(price="100", amount="1", unit="шт", vat="excluded", vat_rate="0.10"), "unknown", None, Rules())
    assert v.factor == D("1.10")

def test_vat_exempt_and_included_not_multiplied():
    for vat in ("exempt", "included"):
        assert resolve_vat(offer(price="100", amount="1", unit="шт", vat=vat), "unknown", None, Rules()).factor == 1

def test_vat_excluded_not_added_when_price_final():   # ЕИС: «Ставка НДС: Без НДС» — 291,40 ₽ не превращается в 355,51 ₽
    v = resolve_vat(offer(price="291.40", amount="1", unit="пачка", vat="excluded"), "included", "ЕИС", Rules(), price_final=True)
    assert v.status == "exempt" and v.factor == 1

def test_vat_unknown_falls_to_source_default():
    o = offer(price="100", amount="1", unit="шт", vat="unknown")
    assert resolve_vat(o, "included", "ЕИС", Rules()).status == "included"
    assert resolve_vat(o, "unknown", None, Rules()).status == "unknown"

CPI = {"2026-05": D("100.5"), "2026-06": D("100.3"), "2026-07": D("100.2")}

def test_index_applied_sum_of_monthly_increments():
    r = index_price(date(2026, 4, 15), date(2026, 8, 10), CPI, Rules(index_after_months=3))
    assert r.status == "applied" and r.factor == D("1.0100")   # (100 + 0.5 + 0.3 + 0.2) / 100

def test_index_not_needed_for_fresh_or_undated_price():
    assert index_price(date(2026, 4, 15), date(2026, 8, 10), CPI, Rules()).status == "not_needed"   # 4 мес ≤ 6
    assert index_price(None, date(2026, 8, 10), CPI, Rules()).status == "not_needed"

def test_index_partial_data_is_noted_and_no_data_is_safe():
    r = index_price(date(2026, 4, 15), date(2026, 8, 10), {"2026-05": D("100.5")}, Rules(index_after_months=3))
    assert r.factor == D("1.0050") and "нет данных" in r.note
    r = index_price(date(2026, 4, 15), date(2026, 8, 10), {}, Rules(index_after_months=3))
    assert r.status == "no_data" and r.factor == 1

def test_index_disabled():
    assert index_price(date(2020, 1, 1), date(2026, 8, 10), CPI, Rules(indexation_enabled=False)).status == "not_needed"

def test_adjusted_price_chain():
    vat = VatResolution(status="added", factor=D("1.22"), note="")
    idx = IndexResolution(status="applied", factor=D("1.0100"), note="")
    dlv = DeliveryResolution(status="added", added_per_unit=D("0.20"), note="")
    assert adjusted_price(D("100.00"), vat, idx, dlv) == D("123.42")   # 100 × 1.22 × 1.01 = 123.22; + 0.20

def test_supplier_key_priority():
    assert supplier_key(offer(supplier_inn="7701234567", supplier="ООО «Ромашка»"), Rules()) == "7701234567"
    assert supplier_key(offer(supplier='ООО "Ромашка"'), Rules()) == supplier_key(offer(supplier="ромашка ООО"), Rules())
    assert supplier_key(offer(url="https://www.komus.ru/p/1"), Rules()) == "komus.ru"

def test_marketplace_and_eis_without_seller_stay_independent():
    assert supplier_key(offer(url="https://ozon.ru/p/1"), Rules()) is None
    assert supplier_key(offer(url="https://zakupki.gov.ru/epz/contract/1", source_id="eis"), Rules()) is None

def test_pick_per_supplier_keeps_latest_then_cheapest():
    a = entry(price="300", supplier_inn="77", price_date=date(2024, 1, 1))
    b = entry(price="320", supplier_inn="77", price_date=date(2025, 6, 1))
    c = entry(price="290", supplier_inn="78")
    kept, dropped = pick_per_supplier([a, b, c], Rules())
    assert kept == [b, c] and dropped == [(a, b)]

def test_diagnose_spread_points_at_source_gap():
    es = [entry(price=p, source_id="eis") for p in ("100", "100", "100")] + \
         [entry(price=p, source_id="web_shops") for p in ("150", "150", "150")]
    hints = diagnose_spread(es, Rules())
    assert "ЕИС" in hints[0] and "33 %" in hints[0] and "3 против 3" in hints[0]

def test_diagnose_spread_silent_when_groups_close():
    es = [entry(price="100", source_id="eis"), entry(price="105", source_id="web_shops")]
    assert diagnose_spread(es, Rules()) == []

def test_diagnose_spread_points_at_vat_exempt_suppliers():   # entry(vat=...) задаёт vat.status
    es = [entry(price=p, source_id="eis", vat="exempt") for p in ("100", "100")] + \
         [entry(price=p, source_id="eis", vat="included") for p in ("130", "130")]
    assert any("без НДС" in h and "2 против 2" in h for h in diagnose_spread(es, Rules()))
```

`offer(...)` и `entry(...)` — хелперы в `tests/fakes.py`; `entry` строит `OfferEntry` с `normalized_price = base_price = price` и нейтральными поправками.

- [ ] **Step 2: FAIL**
- [ ] **Step 3: Реализовать** (границы IQR допустимо считать во float — на результат влияет только членство в выборке).
- [ ] **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: приведение цен (единицы, НДС, индексация, доставка), отбор по поставщику и расчёт НМЦК`

---

### Task 4: Извлечение текста ТЗ

**Files:**
- Create: `backend/app/pipeline/extract_text.py`; скопировать три ТЗ из `docs/` в `backend/tests/fixtures/`
- Test: `backend/tests/test_extract_text.py`

**Interfaces:**
- Produces: `extract_text(filename: str, data: bytes) -> str` — `.docx` (параграфы и таблицы в порядке документа, ячейки строки через ` | `), `.pdf` (pypdf), `.txt`/`.md` (utf-8); прочее → `ValueError("Неподдерживаемый формат файла: …")`.

- [ ] **Step 1: Тесты**

```python
def test_docx_tables_are_extracted():
    t = extract_text("x.docx", (FIX / "ТЗ поставка бумаги.docx").read_bytes())
    assert "SvetoCopy" in t and "2500" in t and "17.12.14.160" in t

def test_docx_cytokines_keeps_characteristics():
    t = extract_text("x.docx", (FIX / "ТЗ поставка цитокинов.docx").read_bytes())
    assert "rhIL-21" in t and "Coomassie" in t

def test_unsupported():
    with pytest.raises(ValueError): extract_text("a.xlsx", b"")
```

- [ ] **Step 2: FAIL** → **Step 3:** обход `document.element.body` по `w:p`/`w:tbl` через python-docx → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: извлечение текста ТЗ из docx/pdf/txt`

---

### Task 5: LLM-клиент OpenRouter

**Files:**
- Create: `backend/app/llm/client.py`, `backend/app/llm/prompts.py` (пустой модуль под промпты), `backend/tests/fakes.py` (FakeLLM)
- Test: `backend/tests/test_llm_client.py`

**Interfaces:**
- Produces:
  - `class LLM(Protocol)`: `async def complete_json(self, system: str, user: str, schema_name: str, schema: dict) -> dict`; `async def chat(self, messages: list[dict], tools: list[dict]) -> dict` (возвращает assistant-сообщение OpenAI-формата с возможными `tool_calls`).
  - `class LLMFormatError(Exception)`, `class LLMAuthError(Exception)`.
  - `OpenRouterLLM(api_key: str, model: str, http: httpx.AsyncClient | None = None)`; base URL `https://openrouter.ai/api/v1`, `POST /chat/completions`, `response_format={"type":"json_schema","json_schema":{"name":schema_name,"schema":schema,"strict":True}}`. Битый JSON → один повтор с сообщением «Ответ не является корректным JSON по схеме, повтори», затем `LLMFormatError`. HTTP 401/403 → `LLMAuthError`.
  - `tests/fakes.py`: `FakeLLM(json_responses: list[dict] | Callable[[str, str, str], dict], chat_responses: list[dict] = [])` — отдаёт ответы по очереди, пишет вызовы в `.calls`.

- [ ] **Step 1: Тесты (respx)**

```python
async def test_complete_json_parses(respx_mock):
    respx_mock.post(URL).respond(json=completion('{"a": 1}'))
    assert await OpenRouterLLM("k", "m").complete_json("s", "u", "x", {}) == {"a": 1}

async def test_retries_once_then_raises(respx_mock):
    route = respx_mock.post(URL).respond(json=completion("not json"))
    with pytest.raises(LLMFormatError): await OpenRouterLLM("k", "m").complete_json("s", "u", "x", {})
    assert route.call_count == 2

async def test_auth_error(respx_mock):
    respx_mock.post(URL).respond(401, json={"error": {"message": "bad key"}})
    with pytest.raises(LLMAuthError): await OpenRouterLLM("k", "m").complete_json("s", "u", "x", {})
```

- [ ] **Step 2: FAIL** → **Step 3: Реализовать** → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: клиент OpenRouter с JSON-схемами и повтором`

---

### Task 6: Разбор ТЗ в позиции и вопросы

**Files:**
- Create: `backend/app/pipeline/parse_tz.py`; промпт `PARSE_TZ_SYSTEM` в `llm/prompts.py`
- Test: `backend/tests/test_parse_tz.py`

**Interfaces:**
- Consumes: `LLM`, `Position`, `Question`, `Basis`.
- Produces: `ParsedTZ(title: str, positions: list[Position], questions: list[Question], delivery_terms: str | None = None, delivery_extras: list[str] = [])` — `delivery_terms` — краткое требование ТЗ к поставке («до адреса заказчика, все расходы включены в цену»), `delivery_extras` — дополнительные работы при поставке, которые обычно не входят в цену магазина (например `["разгрузка", "занос в помещение 1 этажа"]`, `["доставка до места установки"]`); `async def parse_tz(llm: LLM, tz_text: str) -> ParsedTZ`; `async def apply_answer(llm: LLM, position: Position, question: Question, answer: str) -> Position`.
- Промпт фиксирует: существенные характеристики = влияющие на цену/сопоставимость (модель, формат, плотность, масса, чистота, …), прочие — `essential=false`; `basis` — единица сравнения цены (для «шт. не менее 10 мкг» → `{unit:"мкг", per_tz_unit:10}`; для пачек → `{unit:"пачка", per_tz_unit:1}`); вопрос задаётся только при реальной неоднозначности, всегда с `default_answer`, который уже отражён в позиции. `Question.id` = `q{position_index}-{n}`.
- Марка/товарный знак, названные в ТЗ без «или эквивалент», — существенная характеристика «Товарный знак»; по такой позиции задаётся вопрос «Учитывать аналоги без марки <X> с теми же характеристиками?» с `default_answer` «Нет, только <X>». Характеристики, которые источники почти никогда не публикуют и которые следуют из существенных (толщина при заданных марке и плотности, ГОСТ, страна происхождения), — `essential=false`.
- `search_terms` — 1–3 коротких запроса для поиска по реестрам: марка/модель (если есть) и родовое название товара, как оно звучит в каталогах и КТРУ («SvetoCopy», «бумага для офисной техники»; «бумага офсетная», «бумага писчая»). Без формата, плотности и количества: в ЕИС они не сужают выдачу, их проверяет сопоставление (спека 5.4.1).

- [ ] **Step 1: Тесты**

```python
async def test_parse_tz_builds_positions():
    llm = FakeLLM([{"title": "Бумага", "positions": [paper_pos_json()], "questions": []}])
    r = await parse_tz(llm, "текст")
    assert r.positions[0].quantity == Decimal(2500) and r.positions[0].basis.unit == "пачка"
    assert r.positions[0].search_terms  # paper_pos_json() содержит search_terms

async def test_parse_tz_question_ids_and_defaults():
    llm = FakeLLM([{"title": "Цитокины", "positions": [cyto_pos_json()],
                    "questions": [{"position_index": 1, "text": "Считать за мкг?", "default_answer": "Да, за 10 мкг"}]}])
    q = (await parse_tz(llm, "т")).questions[0]
    assert q.id == "q1-1" and q.default_answer and q.answer is None

@pytest.mark.live
async def test_parse_real_cytokines():  # запускается только с OPENROUTER_API_KEY
    r = await parse_tz(real_llm(), extract_text("x.docx", (FIX / "ТЗ поставка цитокинов.docx").read_bytes()))
    assert len(r.positions) == 5 and r.positions[0].basis.unit == "мкг"
```

- [ ] **Step 2: FAIL** → **Step 3: Реализовать** (`live` маркер регистрируется в pyproject и пропускается без ключа) → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: разбор ТЗ в позиции и уточняющие вопросы`

---

### Task 7: Источники — база, загрузка страниц, веб-поиск

**Files:**
- Create: `backend/app/sources/base.py`, `backend/app/sources/fetch.py`, `backend/app/sources/web.py`
- Test: `backend/tests/test_fetch.py`, `backend/tests/test_web_source.py`

**Interfaces:**
- Produces:
  - `CandidatePage(url: str, title: str, text: str, retrieved_at: datetime)`
  - `SourceResult(pages: list[CandidatePage], run: SourceRun, skipped: list[SkippedPage] = [])` — `skipped` — страницы, которые источник отбросил по своему правилу (ЕИС: контракт с неустойками), с причиной для отчёта
  - `class SourceAdapter(Protocol)`: атрибуты `id: str, name: str, level: int, cfg: SourceConfig` (`cfg` нужен для `policy_for` при решении по доставке); `async def search(self, position: Position, rules: Rules) -> SourceResult` — **никогда не бросает**: любые ошибки → `run.status` `unavailable` (сеть/таймаут/5xx) или `error` (прочее) с текстом в `run.error`; 0 страниц → `empty`.
  - `async def fetch_page(http: httpx.AsyncClient, url: str, limit: int) -> CandidatePage` — таймаут 20 с, 2 повтора на сетевые/5xx, браузерный User-Agent, HTML → текст через selectolax (без script/style), обрезка до `limit`.
  - `class WebSearch(Protocol)`: `async def search(self, query: str, max_results: int) -> list[tuple[str, str]]` (url, title). Реализация `OpenRouterWebSearch(api_key, model)` — запрос к `/chat/completions` с `plugins=[{"id":"web","max_results":N}]`, URL берутся из `choices[0].message.annotations` типа `url_citation`.
  - `WebSource(cfg: SourceConfig, search: WebSearch, http: httpx.AsyncClient)`: запросы `f"{position.name} {ключевые essential-характеристики (до 3)} {params.query_suffix}"`; при `params.sites` — по запросу `site:<домен>` на каждый сайт; дедуп URL; не более `rules.max_pages_per_source` страниц; страницы, которые не загрузились, пропускаются.

- [ ] **Step 1: Тесты**

```python
async def test_fetch_page_strips_scripts(respx_mock):
    respx_mock.get("https://a.ru/p").respond(html="<html><title>T</title><script>x()</script><body>Цена 290 ₽</body></html>")
    p = await fetch_page(httpx.AsyncClient(), "https://a.ru/p", 1000)
    assert "290" in p.text and "x()" not in p.text and p.title == "T"

async def test_web_source_never_raises_on_network_error():
    src = WebSource(cfg_web(), FailingSearch(httpx.ConnectError("down")), httpx.AsyncClient())
    r = await src.search(paper_position(), Rules())
    assert r.run.status == "unavailable" and r.pages == []

async def test_web_source_site_queries():
    search = RecordingSearch(results=[("https://komus.ru/x", "x")])
    await WebSource(cfg_web(sites=["komus.ru"]), search, mock_http_ok()).search(paper_position(), Rules())
    assert any("site:komus.ru" in q for q in search.queries)
```

- [ ] **Step 2: FAIL** → **Step 3: Реализовать** → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: адаптеры источников, загрузка страниц, веб-поиск`

---

### Task 8: Адаптер ЕИС (реестр контрактов)

Устройство адаптера опирается на ручной поиск по ТЗ на бумагу (спека 5.4.1). Цена берётся из строки контракта, а не из цены всего контракта. Полные характеристики строки открываются отдельной ссылкой. ОКПД2 из ТЗ не фильтрует, неустойки проверяет код.

**Files:**
- Create: `backend/app/sources/eis.py`, `backend/app/sources/registry.py`; фикстуры `backend/tests/fixtures/eis_search.html`, `eis_common.html`, `eis_payment.html`, `eis_ktru.html`, `eis_process.html`, `eis_process_penalty.html`
- Test: `backend/tests/test_eis.py`, `backend/tests/test_registry.py`

**Interfaces:**
- Consumes: `fetch_page`, `SourceAdapter`, `SourceResult`, `SkippedPage`.
- Produces:
  - `EisSource(cfg: SourceConfig, http: httpx.AsyncClient)`.
    - **Поиск:** `https://zakupki.gov.ru/epz/contract/search/results.html`, по одному запросу на каждый элемент `position.search_terms` (пусто → `[position.name]`). Параметры, подтверждённые в реальной сессии: `searchString=<запрос>`, `morphology=on` (словоформы; строгий `strictEqual=true` для «офсетная» не нашёл ничего), `fz44=on`, `contractStageList_1=on&contractStageList=1` (исполнение завершено), `sortBy=UPDATE_DATE`, `sortDirection=false`, `pageNumber=1`, `recordsPerPage=_50`. Параметр даты заключения (последние `rules.eis_years` лет) взять из адресной строки на Step 1. URL собирает `search_url(term: str, rules: Rules) -> str`. **ОКПД2 в фильтр не ставить:** в ТЗ у SvetoCopy 17.12.14.160, а в подходящих контрактах — 17.12.14.110.
    - `parse_search_results(html: str) -> list[str]` — реестровые номера контрактов (`reestrNumber` из ссылок `contractCard/common-info.html?reestrNumber=…`) в порядке выдачи. Номера по всем запросам дедуплицируются, берётся не больше `rules.max_pages_per_source` контрактов.
    - **Контракт** — до 4 запросов (не больше 2 параллельно):
      1. `contractCard/common-info.html?reestrNumber=N` — дата заключения, поставщик и ИНН, место поставки, ссылка на вкладку исполнения;
      2. `contractCard/payment-info-and-target-of-order.html?reestrNumber=N` (без `contractInfoId` открывается) — строки «Объекты закупки»: наименование, товарный знак, ОКПД2/КТРУ, количество и единица («пач»), цена за единицу, «Ставка НДС: 22% / Без НДС»;
      3. `contractCard/ktru-characteristics.html?contractSubjectId=…` для каждой строки, где есть ссылка «Все характеристики ТРУ», не больше 10 строк. Без этого в тексте нет плотности, белизны и марки;
      4. `contractCard/process-info.html?…` (ссылка с вкладки 1) — **неустойки**. `penalties(html) -> bool | None` (код, selectolax): находит таблицу с заголовком столбца, содержащим «НЕУСТОЙКИ», и возвращает `True`, если хоть одна ячейка этого столбца не «Нет». Если таблица не найдена — `None`.
    - Если `penalties is True` — `CandidatePage` не создаётся, в `SourceResult.skipped` добавляется `SkippedPage(url, "eis", "По контракту начислены неустойки (штрафы, пени) — по условиям кейса не используется")`. Если `None` — страница остаётся, в её текст добавляется строка «Сведения о неустойках не найдены».
    - Один `CandidatePage` на контракт: `url` — вкладка 2 (на неё ведёт ссылка в отчёте); `text` — склейка текстов вкладок 1 и 2 и характеристик строк из 3 с подписью «Строка K: …». Цены извлекает общий `extract_offers` (Task 9), поэтому изменение вёрстки карточки не ломает адаптер. В тексте обязательно есть дата заключения, наименование и ИНН поставщика, ставка НДС каждой строки.
    - Ошибка загрузки вкладок 3–4 не роняет контракт: страница отдаётся без них. Ошибка вкладки 2 — контракт пропускается.
  - `build_adapters(sources: list[SourceConfig], search: WebSearch, http: httpx.AsyncClient) -> dict[int, list[SourceAdapter]]` — только `enabled`, по уровням.

- [ ] **Step 1: Сохранить реальные страницы.** ЕИС открывается из обычного браузера на машине с российским IP. Открыть поиск по «SvetoCopy» с фильтрами выше и сохранить HTML выдачи. Затем сохранить вкладки контракта **2610300092726000086** (SvetoCopy А4, 650 пач. × 291,40 ₽, «Без НДС», неустоек нет): «Общая информация», «Платежи и объекты закупки», «Все характеристики ТРУ» по строке 1, «Исполнение (расторжение) контракта». `eis_process_penalty.html` — копия `eis_process.html`, где в графе «Неустойки» вместо «Нет» стоит сумма. Точные параметры URL (в том числе дату заключения) взять из адресной строки и записать константами в `eis.py`.
- [ ] **Step 2: Тесты**

```python
def test_parse_search_results_returns_reestr_numbers():
    nums = parse_search_results((FIX / "eis_search.html").read_text())
    assert nums and all(n.isdigit() and len(n) == 19 for n in nums)

async def test_contract_page_has_line_vat_supplier_and_full_characteristics(respx_mock):
    mock_eis_contract(respx_mock, process="eis_process.html")   # отдаёт 4 вкладки из фикстур
    r = await EisSource(cfg_eis(), httpx.AsyncClient()).search(paper_position(search_terms=["SvetoCopy"]), Rules())
    t = r.pages[0].text
    assert "291,40" in t and "Без НДС" in t and "19.10.2026" in t and "051205954080" in t
    assert "Белизна по CIE 146" in t and "80Грамм" in t        # пришло со страницы «Все характеристики ТРУ»
    assert "payment-info-and-target-of-order" in r.pages[0].url

async def test_contract_with_penalties_is_skipped(respx_mock):
    mock_eis_contract(respx_mock, process="eis_process_penalty.html")
    r = await EisSource(cfg_eis(), httpx.AsyncClient()).search(paper_position(search_terms=["SvetoCopy"]), Rules())
    assert r.pages == [] and "неустойки" in r.skipped[0].reason

def test_search_url_has_no_okpd2_filter():
    url = search_url("SvetoCopy", Rules())
    assert "fz44=on" in url and "contractStageList=1" in url and "okpd" not in url.lower()

async def test_eis_unavailable_is_status_not_exception(respx_mock):
    respx_mock.get(url__startswith="https://zakupki.gov.ru").mock(side_effect=httpx.ConnectTimeout("t"))
    r = await EisSource(cfg_eis(), httpx.AsyncClient()).search(paper_position(), Rules())
    assert r.run.status == "unavailable"

def test_registry_groups_by_level():
    a = build_adapters(load_sources(Path("config/sources.yaml")), FakeSearch(), httpx.AsyncClient())
    assert {x.id for x in a[1]} == {"eis", "web_suppliers"} and {x.id for x in a[2]} == {"web_shops"}
```

- [ ] **Step 3: FAIL** → **Step 4: Реализовать** → **Step 5: PASS**
- [ ] **Step 6: Commit** `feat: адаптер ЕИС (строки контракта, характеристики КТРУ, проверка неустоек) и реестр источников`

---

### Task 9: Извлечение предложений и сопоставление

**Files:**
- Create: `backend/app/pipeline/extract.py`, `backend/app/pipeline/match.py`; промпты `EXTRACT_SYSTEM`, `MATCH_SYSTEM`
- Test: `backend/tests/test_extract.py`, `backend/tests/test_match.py`

**Interfaces:**
- Consumes: `LLM`, `parse_price`, `CandidatePage`, `Position`, `Offer`, `CharComparison`.
- Produces:
  - `ExtractFailure(page: CandidatePage, reason: str)`
  - `async def extract_offers(llm: LLM, position: Position, page: CandidatePage, source: SourceAdapter) -> tuple[list[Offer], list[ExtractFailure]]` — LLM возвращает строки (`price`, `amount`, `amount_unit`, `vat`, `vat_rate`, `supplier`, `supplier_inn`, `delivery`, `delivery_cost`, `delivery_free_from`, `delivery_note`, `price_date`, `title`, `characteristics`) только для предложений, относящихся к позиции; промпт `EXTRACT_SYSTEM` требует брать условия доставки только из текста страницы (`included` — только при явном «бесплатная доставка»/«доставка включена» без условий; порог — в `delivery_free_from`; `separate` — только при явной сумме; во всех прочих случаях `unknown`, ничего не угадывать); НДС — так же только из текста: `included` при «с НДС»/«в т. ч. НДС», `excluded` при «без НДС»/«+ НДС»/«цена без учёта НДС», `exempt` при «НДС не облагается»; в строке контракта ЕИС «Ставка НДС: N%» → `included` с `vat_rate`, «Ставка НДС: Без НДС» → `exempt`; иначе `unknown`; `vat_rate` — только если ставка написана; одна строка объекта закупки = одно предложение, строки другого формата/вида бумаги в том же контракте не берутся; `supplier`/`supplier_inn` — продавец или поставщик, если он назван на странице (для маркетплейса — продавец, не площадка), иначе `null`; `price_date` — дата контракта или дата цены со страницы, иначе `null`; код парсит числа (непарсимые `delivery_cost`/`delivery_free_from` → `None`, при этом `separate` без суммы становится `unknown`; `vat_rate` приводится к доле: `22`/`22%` → `0.22`, вне диапазона 0–0.3 → `None`; `supplier_inn` — только 10 или 12 цифр, иначе `None`); непарсимая цена → `ExtractFailure` с причиной «цена не указана или не распознана»; `LLMFormatError` → один `ExtractFailure` на страницу. `Offer.id` = sha1(url + title + price)[:12]; `retrieved_at` = `page.retrieved_at`.
  - `async def compare(llm: LLM, position: Position, offer: Offer) -> list[CharComparison]` — LLM сравнивает каждую характеристику позиции; `ok=None`, если в предложении нет данных.
  - `decide(comparison: list[CharComparison]) -> tuple[ExclusionReason | None, str]` — **код**: если какая-то essential имеет `ok is False` → `("incomparable", "Не соответствует: <имена>")`; если ни одна essential не подтверждена (`ok is True`) → `("insufficient_data", "Недостаточно данных о существенных характеристиках")`; иначе `(None, "Совпадают: <имена подтверждённых essential>")`.
  - `dedupe(offers: list[Offer]) -> tuple[list[Offer], list[Offer]]` — (уникальные, дубли); дубль = совпал канонический URL (нижний регистр хоста, без query/fragment и завершающего `/`) **или** совпали `(source_id, title.casefold(), price)`.

- [ ] **Step 1: Тесты**

```python
def test_decide_rejects_essential_mismatch():
    exc, reason = decide([cc("Формат", "А4", "А3", True, False), cc("Цвет", "белый", "белый", False, True)])
    assert exc == "incomparable" and "Формат" in reason

def test_decide_needs_confirmed_essential():
    exc, reason = decide([cc("Плотность", "80", None, True, None)])
    assert exc == "insufficient_data" and "Недостаточно" in reason

def test_decide_accepts():
    assert decide([cc("Формат", "А4", "А4", True, True)])[0] is None

def test_dedupe_by_canonical_url():
    a, b = offer(url="https://Komus.ru/p/1?utm=x"), offer(url="https://komus.ru/p/1/")
    uniq, dups = dedupe([a, b]); assert len(uniq) == 1 and len(dups) == 1

async def test_extract_unparseable_price_becomes_failure():
    llm = FakeLLM([{"offers": [raw_offer(price="по запросу")]}])
    offers, fails = await extract_offers(llm, paper_position(), page(), fake_source())
    assert offers == [] and "цена" in fails[0].reason

async def test_extract_bad_json_becomes_failure():
    offers, fails = await extract_offers(RaisingLLM(LLMFormatError()), paper_position(), page(), fake_source())
    assert offers == [] and len(fails) == 1
```

- [ ] **Step 2: FAIL** → **Step 3: Реализовать** → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: извлечение предложений и сопоставление по существенным характеристикам`

---

### Task 10: Каскадный прогон и сборка отчёта

**Files:**
- Create: `backend/app/pipeline/research.py`, `backend/app/events.py`
- Test: `backend/tests/test_research.py`

**Interfaces:**
- Consumes: всё из Tasks 3, 7–9.
- Produces:
  - `events.py`: `Event(type: Literal["progress","question","report","error","message"], data: dict)`; `Emit = Callable[[Event], Awaitable[None]]`; `async def noop_emit(e)`.
  - `async def research_position(position: Position, adapters: dict[int, list[SourceAdapter]], llm: LLM, rules: Rules, emit: Emit, calc_date: date | None = None, cpi: dict[str, Decimal] = {}) -> tuple[PositionReport, list[SourceRun]]`:
    1. уровень 1: адаптеры параллельно (`asyncio.gather`), извлечение, дедуп (дубли → `duplicate`), сравнение+`decide` (исключение с типом и причиной из `decide`), нормализация и доставка — для **всех** недублей, включая исключённые `decide`, чтобы `recalculate_position` мог вернуть их без сети (`base_price = normalize_price(...)` → `resolve_vat(offer, cfg.vat_default, cfg.vat_note, rules, cfg.price_final)` → `index_price(offer.price_date, calc_date, cpi, rules)` → `resolve_delivery(offer, policy_for(adapter.cfg, offer.url), base_price, position.quantity)` → `normalized_price = adjusted_price(...)`; `UnitMismatch` → исключение `unit_mismatch`, поправки `None`), затем `pick_per_supplier` по включённым (отброшенные → `same_supplier`, причина «Повторная цена поставщика <название>; в расчёт взята более свежая: <url оставленного>»), затем `find_outliers` (выбросы → `anomalous_price` с текстом правила);
    2. если включённых < `rules.level2_trigger_min_prices` **или** (`rules.level2_on_heterogeneous` и `calculate(...)` по уровню 1 даёт `heterogeneous`) — то же для уровня 2, затем отбор по поставщику, выбросы и расчёт по объединённой выборке (всё пересчитывается заново по объединению); причина подключения уровня 2 пишется в `assumptions` («Уровень 2 подключён: на уровне 1 найдено K цен» / «…: выборка уровня 1 неоднородна, CV = X %»);
    3. `calculate` → `unit_price`, `total = unit_price × quantity` (округл. 0.01); при статусе `heterogeneous` — `spread_hints = diagnose_spread(included, rules)`; в `assumptions` — «Проиндексировано цен: M (ИПЦ Росстата, порог N мес.)», если M > 0; `ExtractFailure` → `skipped_pages` (предложение без цены не создаётся); `SourceResult.skipped` тоже попадает в `skipped_pages`.
    4. `emit(progress)` на старте каждого источника и уровня.
  - `calc_date=None` → сегодняшняя дата.
  - `recalculate_position(pr: PositionReport, rules: Rules) -> PositionReport` — без сети и LLM: заново применяет `overrides` (`exclude` → `user_excluded`; `include` → возвращает в выборку предложение, исключённое как `incomparable`/`insufficient_data`/`same_supplier`; возвращённое вручную предложение в отборе по поставщику не участвует), отбор по поставщику, выбросы, расчёт и `spread_hints`. Сохранённые поправки (`vat`, `indexation`, `delivery`) не пересчитываются — та же версия данных даёт ту же цену.
  - `assemble_report(procurement_id: str, version: int, cause: str, positions: list[PositionReport], sources: list[SourceRun], questions: list[Question], delivery_terms: str | None = None, delivery_extras: list[str] = [], calc_date: date | None = None, methodology: str = Rules().methodology_note) -> Report` — `total` = сумма `total` позиций, если у всех `status == "ok"`, иначе `None`; `warnings` — по каждой позиции не `ok`: «Позиция N «…»: найдено K цен, обоснование недостаточно» / «…: выборка неоднородна (CV = X %)» + через «; » строки `spread_hints`, если есть; по каждой позиции, где у включённых есть `vat.status == "unknown"`: «Позиция N «…»: НДС не подтверждён у M из K предложений — цена может быть занижена»; если есть `indexation.status == "no_data"`: «Позиция N «…»: для M цен прошлых периодов нет данных ИПЦ, индексация не применена»; по каждой позиции, где у включённых есть `delivery.status == "unknown"`: «Позиция N «…»: доставка не подтверждена у M из K предложений — цена может быть занижена»; если `delivery_extras` не пуст: «Требования ТЗ при поставке (<extras через запятую>) в найденных ценах не отражены»; плюс источники `unavailable`/`error`.
  - `async def run_research(procurement_id: str, parsed: ParsedTZ, adapters, llm, rules, emit, version: int) -> Report` — позиции параллельно, вопросы попадают в `Report.questions`, для неотвеченных — `assumptions` «Принято по умолчанию: <default_answer>»; `parsed.delivery_terms`/`delivery_extras` передаются в `assemble_report`. Добавить параметры `calc_date: date | None = None`, `cpi: dict[str, Decimal] = {}`: при первом прогоне `calc_date` = сегодня, при повторных прогонах той же закупки вызывающий код (Task 12/13) передаёт `calc_date` предыдущей версии только для пересчёта без нового поиска; новый поиск берёт сегодняшнюю дату.

- [ ] **Step 1: Тесты (FakeAdapter, FakeLLM)**

`FakeAdapter` даёт каждому предложению свой хост в URL (`https://shop{i}.example/p`), если не заданы `supplier_inns`, — иначе отбор по поставщику схлопнет выборку в одну цену. Необязательные параметры `supplier_inns`, `price_dates`, `vats` — списки по числу цен.

```python
async def test_level2_not_used_when_level1_enough():
    l1 = FakeAdapter(1, prices=["290", "300", "280"]); l2 = FakeAdapter(2, prices=["310"])
    pr, runs = await research_position(paper_position(), {1: [l1], 2: [l2]}, matching_llm(), Rules(), noop_emit)
    assert pr.levels_used == [1] and not l2.called and pr.unit_price == D("290.00")

async def test_level2_used_when_level1_short():
    l1 = FakeAdapter(1, prices=["290"]); l2 = FakeAdapter(2, prices=["300", "280"])
    pr, _ = await research_position(paper_position(), {1: [l1], 2: [l2]}, matching_llm(), Rules(), noop_emit)
    assert pr.levels_used == [1, 2] and pr.status == "ok" and len(pr.included) == 3

async def test_all_sources_down_gives_insufficient_report():
    down = FakeAdapter(1, status="unavailable"); down2 = FakeAdapter(2, status="unavailable")
    pr, runs = await research_position(paper_position(), {1: [down], 2: [down2]}, matching_llm(), Rules(), noop_emit)
    assert pr.status == "insufficient" and pr.unit_price is None and {r.status for r in runs} == {"unavailable"}

async def test_unit_mismatch_is_excluded_with_reason():
    l1 = FakeAdapter(1, prices=["290", "300", "280", "100"], units=["пачка"] * 3 + ["мл"])
    pr, _ = await research_position(paper_position(), {1: [l1], 2: []}, matching_llm(), Rules(), noop_emit)
    assert [e.exclusion for e in pr.excluded] == ["unit_mismatch"]

def test_recalculate_respects_user_exclude():
    pr = position_report_with([D(290), D(300), D(280), D(295)])
    pr.overrides = {pr.included[0].offer.id: "exclude"}
    out = recalculate_position(pr, Rules())
    assert len(out.included) == 3 and out.excluded[-1].exclusion == "user_excluded"

async def test_level2_used_when_level1_heterogeneous():
    l1 = FakeAdapter(1, prices=["100", "140", "60"]); l2 = FakeAdapter(2, prices=["100", "102", "98", "101"])
    pr, _ = await research_position(paper_position(), {1: [l1], 2: [l2]}, matching_llm(), Rules(), noop_emit)
    assert pr.levels_used == [1, 2] and any("неоднородна" in a for a in pr.assumptions)

async def test_same_supplier_keeps_one_price():
    l1 = FakeAdapter(1, prices=["290", "300", "280", "285"], supplier_inns=["77", "77", "78", "79"],
                     price_dates=[date(2026, 9, 1), date(2026, 10, 1), None, None])
    pr, _ = await research_position(paper_position(), {1: [l1], 2: []}, matching_llm(), Rules(), noop_emit)
    assert len(pr.included) == 3 and [e.exclusion for e in pr.excluded] == ["same_supplier"]
    assert pr.excluded[0].offer.price == D("290") and "Повторная цена" in pr.excluded[0].reason

async def test_vat_and_index_applied_before_stats():
    l1 = FakeAdapter(1, prices=["100", "122", "122"], vats=["excluded", "included", "included"])
    pr, _ = await research_position(paper_position(), {1: [l1], 2: []}, matching_llm(), Rules(), noop_emit)
    assert pr.unit_price == D("122.00") and pr.included[0].vat.status == "added"

def test_recalculate_can_return_same_supplier_offer():
    pr = position_report_with([D(290), D(300), D(280)], excluded_same_supplier=[D(295)])
    pr.overrides = {pr.excluded[0].offer.id: "include"}
    assert len(recalculate_position(pr, Rules()).included) == 4

def test_heterogeneous_warning_carries_hint():
    rep = assemble_report("p", 1, "run", [heterogeneous_pr(spread_hints=["цены ЕИС в среднем на 33 % ниже цен остальных источников (3 против 3 предложений)"])], [], [])
    assert any("неоднородна" in w and "ЕИС" in w for w in rep.warnings)

def test_warning_for_unknown_vat():
    rep = assemble_report("p", 1, "run", [ok_pr(total="725000.00", vat=["included", "unknown", "included"])], [], [])
    assert any("НДС не подтверждён у 1 из 3" in w for w in rep.warnings)

def test_report_total_none_if_any_position_not_ok():
    rep = assemble_report("p", 1, "run", [ok_pr(total="725000.00"), insufficient_pr()], [], [])
    assert rep.total is None and len(rep.warnings) == 1

async def test_delivery_resolved_with_source_policy():
    l1 = FakeAdapter(1, prices=["290", "300", "280"], delivery=DeliveryPolicy(included=True, note="ЕИС"))
    pr, _ = await research_position(paper_position(), {1: [l1], 2: []}, matching_llm(), Rules(), noop_emit)
    assert all(e.delivery.status == "included" for e in pr.included)

def test_warnings_for_unknown_delivery_and_extras():
    rep = assemble_report("p", 1, "run", [ok_pr(total="725000.00", delivery=["included", "unknown", "unknown"])], [], [],
                          delivery_extras=["разгрузка", "занос в помещение 1 этажа"])
    assert any("не подтверждена у 2 из 3" in w for w in rep.warnings)
    assert any("разгрузка" in w for w in rep.warnings)
```

- [ ] **Step 2: FAIL** → **Step 3: Реализовать** → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: каскадный поиск по позициям и сборка отчёта`

---

### Task 11: Хранилище и версии отчёта

**Files:**
- Create: `backend/app/store/repo.py`
- Test: `backend/tests/test_repo.py`

**Interfaces:**
- Produces: `Repo(db_path: Path)` на stdlib `sqlite3` (таблицы `procurements(id, title, created_at, filename, tz_text, parsed_json)`, `messages(id, procurement_id, role, content, created_at, meta_json)`, `report_versions(procurement_id, version, created_at, cause, report_json, PK(procurement_id, version))`, `settings(key PK, value)`), методы:
  `create_procurement(title: str, filename: str, tz_text: str) -> str` (uuid4 hex); `list_procurements() -> list[dict]` (id, title, created_at, latest_version, total); `get_procurement(id) -> dict | None`; `save_parsed(id, parsed: ParsedTZ)`; `get_parsed(id) -> ParsedTZ | None`; `add_message(id, role: str, content: str, meta: dict | None = None)`; `list_messages(id) -> list[dict]`; `save_report(report: Report) -> int` (присваивает `version = max+1`, возвращает его); `get_report(id, version: int | None = None) -> Report | None` (None → последняя); `list_versions(id) -> list[dict]` (version, created_at, cause, total); `get_setting(key) -> str | None`; `set_setting(key, value)`.

- [ ] **Step 1: Тесты**

```python
def test_versions_increment(tmp_path):
    repo = Repo(tmp_path / "db.sqlite"); pid = repo.create_procurement("Бумага", "t.docx", "текст")
    assert repo.save_report(sample_report(pid)) == 1 and repo.save_report(sample_report(pid)) == 2
    assert repo.get_report(pid).version == 2 and repo.get_report(pid, 1).version == 1
    assert [v["version"] for v in repo.list_versions(pid)] == [1, 2]

def test_settings_roundtrip(tmp_path):
    repo = Repo(tmp_path / "db.sqlite"); repo.set_setting("openrouter_api_key", "k")
    assert repo.get_setting("openrouter_api_key") == "k" and repo.get_setting("x") is None
```

- [ ] **Step 2: FAIL** → **Step 3: Реализовать** → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: SQLite-хранилище закупок, сообщений и версий отчёта`

---

### Task 12: API, события и контракт для фронтенда

**Files:**
- Create: `backend/app/api/routes.py`, `docs/api.md`; Modify: `backend/app/main.py`
- Test: `backend/tests/test_api.py`

**Interfaces:**
- Consumes: `Repo`, `extract_text`, `parse_tz`, `run_research`, `build_adapters`, `OpenRouterLLM`, `OpenRouterWebSearch`.
- Produces (все пути с префиксом `/api`; ошибки — `{"detail": "<русский текст>"}`):
  - `GET /settings` → `{"has_api_key": bool, "model": str}`; `PUT /settings` `{"openrouter_api_key"?: str, "model"?: str}`.
  - `POST /procurements` multipart `file` **или** form `text` → `201 {"id": str}` (извлечение текста сразу; ошибка формата → 400).
  - `GET /procurements` → список из `Repo.list_procurements`.
  - `GET /procurements/{id}` → `{"id","title","created_at","messages":[…],"latest_version": int | null}`.
  - `POST /procurements/{id}/run` → `202`; нет ключа → `400 {"detail":"Не задан ключ OpenRouter. Укажите его в настройках."}`. Фоном: `parse_tz` → вопросы в чат (`message` с `meta.question_id`) → `run_research` → `save_report` → событие `report {version}`. `LLMAuthError` → событие `error` «Ключ OpenRouter недействителен».
  - `GET /procurements/{id}/events` — SSE (`sse-starlette`), события `Event` из `events.py` в формате `event: <type>\ndata: <json>`; шина — `asyncio.Queue` на каждого подписчика в `events.py` (`EventBus.publish(procurement_id, Event)`, `EventBus.subscribe(procurement_id)`).
  - `POST /procurements/{id}/messages` `{"text": str}` → `202`; ответ агента приходит событиями (Task 13).
  - `GET /procurements/{id}/reports` → версии; `GET /procurements/{id}/reports/{version|latest}` → `Report` JSON.
  - `GET /procurements/{id}/reports/{version}/export.docx` (Task 14).
- `docs/api.md` — эти эндпоинты, примеры запросов/ответов и пример `Report` JSON (из `make_sample_report`), чтобы фронтенд мог работать на моках.
- **Контракт уже согласован заранее** (`docs/api.md`, примеры в `docs/api-examples/`) и главнее списка выше: эндпоинты, модели и события реализуются по нему, отличия от этого плана перечислены в его §8. Тест `test_api_contract.py` валидирует примеры моделями (§9 контракта). Расхождение реализации с контрактом — правка контракта отдельным коммитом.

- [ ] **Step 1: Тесты (TestClient, зависимость Repo/LLM подменяется через `app.dependency_overrides`)**

```python
def test_run_without_key_is_400(client_no_key):
    pid = client_no_key.post("/api/procurements", data={"text": "ТЗ"}).json()["id"]
    r = client_no_key.post(f"/api/procurements/{pid}/run")
    assert r.status_code == 400 and "ключ OpenRouter" in r.json()["detail"]

def test_upload_unsupported_format_is_400(client):
    r = client.post("/api/procurements", files={"file": ("a.xlsx", b"x")}); assert r.status_code == 400

def test_run_creates_report_version(client_with_fakes):
    pid = client_with_fakes.post("/api/procurements", data={"text": "ТЗ"}).json()["id"]
    assert client_with_fakes.post(f"/api/procurements/{pid}/run").status_code == 202
    wait_until(lambda: client_with_fakes.get(f"/api/procurements/{pid}/reports").json())
    rep = client_with_fakes.get(f"/api/procurements/{pid}/reports/latest").json()
    assert rep["version"] == 1 and rep["positions"]

def test_settings_never_returns_key(client):
    client.put("/api/settings", json={"openrouter_api_key": "secret"})
    assert "secret" not in client.get("/api/settings").text
```

- [ ] **Step 2: FAIL** → **Step 3: Реализовать + `docs/api.md`** → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: REST/SSE API и контракт для фронтенда`

---

### Task 13: Чат-агент

**Files:**
- Create: `backend/app/agent/chat.py`; промпт `CHAT_SYSTEM`; Modify: `backend/app/api/routes.py` (обработчик `messages`)
- Test: `backend/tests/test_chat.py`

**Interfaces:**
- Consumes: `LLM.chat`, `Repo`, `recalculate_position`, `research_position`, `apply_answer`, `assemble_report`, `EventBus`.
- Produces: `async def handle_message(procurement_id: str, text: str, deps: AgentDeps) -> None`, где `AgentDeps(repo, llm, adapters, rules, bus)`. Цикл: история сообщений + последняя версия отчёта (кратко: позиции, включённые/исключённые с `offer.id`, вопросы) → `llm.chat` с инструментами → выполнение → до 5 итераций → финальный текст сохраняется и публикуется событием `message`.
- Инструменты (JSON-схемы OpenAI-формата):
  - `exclude_offer(position_index: int, offer_id: str, reason: str)` / `include_offer(position_index: int, offer_id: str)` → `overrides` + `recalculate_position` → новая версия, `cause` = «Пользователь: исключено/включено предложение …».
  - `answer_question(question_id: str, answer: str)` → `Question.answer`, `apply_answer` → `research_position` для этой позиции → новая версия.
  - `rerun_position(position_index: int)` → `research_position` → новая версия.
  - Каждая новая версия публикуется событием `report {version}`.
- Ответ на уточняющий вопрос пользователь может дать и простым сообщением — агент сам вызывает `answer_question`.

- [ ] **Step 1: Тесты (FakeLLM с `chat_responses`)**

```python
async def test_exclude_offer_creates_new_version(deps_with_report_v1):
    deps = deps_with_report_v1(chat=[tool_call("exclude_offer", position_index=1, offer_id=OID, reason="б/у"), text("Готово")])
    await handle_message(PID, "исключи третье предложение", deps)
    rep = deps.repo.get_report(PID)
    assert rep.version == 2 and any(e.offer.id == OID and e.exclusion == "user_excluded" for e in rep.positions[0].excluded)

async def test_answer_question_reruns_position(deps_with_report_v1):
    deps = deps_with_report_v1(chat=[tool_call("answer_question", question_id="q1-1", answer="За 10 мкг"), text("Пересчитал")])
    await handle_message(PID, "считай за 10 мкг", deps)
    rep = deps.repo.get_report(PID)
    assert rep.questions[0].answer == "За 10 мкг" and rep.version == 2

async def test_unknown_offer_id_is_reported_not_raised(deps_with_report_v1):
    deps = deps_with_report_v1(chat=[tool_call("exclude_offer", position_index=1, offer_id="nope", reason="x"), text("Не нашёл")])
    await handle_message(PID, "исключи", deps)
    assert deps.repo.get_report(PID).version == 1
```

- [ ] **Step 2: FAIL** → **Step 3: Реализовать** → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: чат-агент с правками отчёта через инструменты`

---

### Task 14: Экспорт в DOCX

**Files:**
- Create: `backend/app/report/docx_export.py`; Modify: `backend/app/api/routes.py`
- Test: `backend/tests/test_docx_export.py`

**Interfaces:**
- Produces: `render_docx(report: Report, title: str) -> bytes` — разделы из спецификации §5.7: «Предмет закупки», «Где искали», «Включённые предложения» (источник, ссылка, дата получения, поставщик, дата цены, исходная цена и ед., цена за ед. ТЗ (`base_price`), НДС — статус и `note`, индексация — коэффициент и `note`, доставка — статус и `note`, расчётная цена, причина), «Исключённые предложения», «Расчёт» (первой строкой — `report.methodology` и дата расчёта `calc_date`; формула расчётной цены; правило выбросов, n, мин, макс, среднее, СКО, CV, НДС: с НДС / начислен / не облагается / неизвестен — число предложений, проиндексировано цен, доставка: включена / добавлена / неизвестна — число предложений, НМЦК за ед. и по позиции, итог; над расчётом — `delivery_terms` из ТЗ), «Предупреждения». Оформление — минимальное; финальный вид отчёта решит команда.

- [ ] **Step 1: Тест**

```python
def test_docx_contains_sections_and_links():
    doc = Document(io.BytesIO(render_docx(make_sample_report(), "Бумага")))
    text = "\n".join(p.text for p in doc.paragraphs) + "\n".join(c.text for t in doc.tables for r in t.rows for c in r.cells)
    for h in ["Предмет закупки", "Где искали", "Включённые предложения", "Исключённые предложения", "Расчёт", "Предупреждения"]:
        assert h in text
    assert "https://" in text and "290,00" in text   # деньги в русском формате
    assert "приказ" in text and "223-ФЗ" in text      # методика и оговорка о применимости
```

- [ ] **Step 2: FAIL** → **Step 3: Реализовать + эндпоинт** → **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: экспорт отчёта в DOCX`

---

### Task 15: CLI, README, архитектура, use cases

**Files:**
- Create: `backend/app/cli.py`, `docs/architecture.md`, `docs/examples/` (результаты прогонов); Modify: `README.md`
- Test: `backend/tests/test_cli.py`

**Interfaces:**
- Produces: `python -m app.cli run <tz_path> [--out report.json] [--docx report.docx]` — тот же конвейер без API, ключ из env; печатает прогресс и итог по позициям; код выхода 0 при успешном отчёте (в т. ч. со статусами `insufficient`), 2 — нет ключа.

- [ ] **Step 1: Тест**

```python
def test_cli_without_key_exits_2(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert main(["run", str(FIX / "ТЗ поставка бумаги.docx")]) == 2
```

- [ ] **Step 2: FAIL** → **Step 3: Реализовать** → **Step 4: PASS**
- [ ] **Step 5: Живые прогоны.** `docker compose run --rm backend python -m app.cli run tests/fixtures/"ТЗ поставка бумаги.docx" --out /data/paper.json --docx /data/paper.docx`, то же для цитокинов и 3D-принтера. Сохранить JSON/DOCX в `docs/examples/`. Проверить вручную: ≥ 1 позиция бумаги со статусом `ok`, у цитокинов задан вопрос про единицу и `basis.unit == "мкг"`, у всех предложений есть `url`.
- [ ] **Step 6: Документация.**
  - `README.md`: требования (Docker 24+, Docker Compose v2, ключ OpenRouter), запуск `cp .env.example .env && docker compose up -d --build`, остановка `docker compose down`, переменные окружения, внешние сервисы (OpenRouter, zakupki.gov.ru, сайты из `sources.yaml`), как менять источники и правила (YAML: ставка НДС, порог и таблица ИПЦ для индексации, текст методики под положение о закупке заказчика), CLI, ≥ 2 use case (бумага, цитокины) с входом и ожидаемым результатом из `docs/examples/`.
  - `docs/architecture.md`: компоненты, поток данных от ТЗ до отчёта (диаграмма mermaid), каскад, разделение LLM/код, формула расчётной цены (единица ТЗ → НДС → индексация → доставка), правило одной цены от поставщика, правило выбросов, что происходит при неоднородной выборке, обработка отказов источников.
- [ ] **Step 7: Проверка чистого запуска:** `git clone` в пустую папку → шаги README → `curl localhost:8000/api/health` → ok.
- [ ] **Step 8: Commit** `docs: README, архитектура, use cases, CLI`
