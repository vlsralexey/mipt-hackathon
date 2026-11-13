# Бэкенд агента НМЦК (P0) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Локальный бэкенд, который по ТЗ ищет предложения в открытых источниках (каскад уровней), сопоставляет, нормализует, считает НМЦК и отдаёт структурированный отчёт через API, CLI и DOCX, запускаясь через `docker compose up`.

**Architecture:** FastAPI-приложение на Python. Детерминированный конвейер (разбор ТЗ → поиск по адаптерам → извлечение → сопоставление → нормализация → расчёт) с LLM (OpenRouter) только на шагах разбора, извлечения и сравнения характеристик. Все числа считает код на `Decimal`. Состояние — SQLite в Docker-томе, каждый пересчёт создаёт новую версию отчёта. Чат-агент меняет данные через инструменты и запускает пересчёт.

**Tech Stack:** Python 3.12, FastAPI, uvicorn, pydantic v2, httpx, sse-starlette, python-docx, pypdf, PyYAML, selectolax, pytest, pytest-asyncio (`asyncio_mode=auto`), respx.

**Spec:** `docs/superpowers/specs/2026-11-13-nmck-agent-design.md`

**Вне этого плана:** фронтенд (отдельный план после макетов, работает по контракту из Task 12), P1 — маркетплейсы через Playwright и живое окно, правка конфига агентом, UI версий (отдельный план).

## Порядок выполнения

Ветка: `dev`. Исполнение: superpowers:subagent-driven-development, тремя сессиями; каждая заканчивается рабочим протестированным состоянием и сводкой.

| Сессия | Задачи | Результат | Нужно заранее |
|---|---|---|---|
| 1 | 1–5 | Каркас, Docker, нормализация и расчёт, извлечение текста ТЗ, клиент OpenRouter | — (всё на тестах) |
| 2 | 6–10 | Разбор ТЗ, источники (ЕИС, веб), сопоставление, каскад | Ключ OpenRouter; HTML выдачи ЕИС и карточки контракта для фикстур Task 8 (сохранить из обычного браузера, если ЕИС не открывается из окружения агента) |
| 3 | 11–15 | Хранилище, API + `docs/api.md`, чат-агент, DOCX, CLI, README, живые прогоны | Ключ OpenRouter |

Запуск сессии:

```
Используй superpowers:subagent-driven-development и выполни задачи N–M из плана
docs/superpowers/plans/2026-11-13-nmck-backend-p0.md (спека: docs/superpowers/specs/2026-11-13-nmck-agent-design.md).
Работаем в ветке dev. После задачи M остановись и дай сводку.
```

## Global Constraints

- LLM-провайдер — только OpenRouter; ключ из настроек (БД), запасной вариант — env `OPENROUTER_API_KEY`; модель — env `OPENROUTER_MODEL` / настройки. Идентификатор модели по умолчанию сверить на openrouter.ai/models при реализации.
- LLM извлекает и сравнивает; нормализация, выбросы, статистика, НМЦК — только код, на `Decimal`, деньги округляются до копеек `ROUND_HALF_UP`.
- Метод сопоставимых рыночных цен: НМЦК за единицу = среднее по включённым ценам; СКО с n−1; CV = СКО / среднее; однородность при CV ≤ 0,33; минимум 3 цены.
- Правило выбросов: n ≥ 5 — вне [Q1 − 1,5·IQR; Q3 + 1,5·IQR] (`statistics.quantiles(..., n=4, method="inclusive")`); n < 5 — |ц − медиана| / медиана > 0,5.
- Если после исключения цен < 3 → статус `insufficient`; если CV > 0,33 → `heterogeneous`. В обоих случаях `unit_price = None`, среднее идёт в `reference_price`.
- Каскад по позиции: уровень 2 подключается, если после исключения выбросов на уровне 1 осталось < 3 включённых цен; затем расчёт по объединённой выборке.
- Все пороги — в `backend/config/rules.yaml`, источники — в `backend/config/sources.yaml`; код их не хардкодит.
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

---

## Структура файлов

```
backend/
  pyproject.toml
  Dockerfile
  config/sources.yaml        # источники: id, name, level, type, enabled, params
  config/rules.yaml          # пороги расчёта и сопоставления
  app/
    models.py                # доменные модели (контракт отчёта)
    config.py                # Settings (env) + загрузка YAML
    units.py                 # единицы, parse_price, parse_amount
    pipeline/normalize.py    # приведение цены к единице ТЗ
    pipeline/calc.py         # выбросы, статистика, НМЦК
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
  - `Position(index: int, name: str, unit: str, quantity: Decimal, okpd2: str | None, characteristics: list[Characteristic], basis: Basis)`
  - `Question(id: str, position_index: int, text: str, default_answer: str, answer: str | None = None)`
  - `Offer(id: str, source_id: str, source_name: str, level: int, url: str, retrieved_at: datetime, title: str, price: Decimal, currency: str = "RUB", amount: Decimal, amount_unit: str, vat: Literal["included","excluded","unknown"], delivery: Literal["included","separate","unknown"], delivery_cost: Decimal | None, price_date: date | None, characteristics: dict[str, str])`
  - `CharComparison(name: str, required: str, offered: str | None, essential: bool, ok: bool | None)`
  - `ExclusionReason = Literal["anomalous_price","incomparable","unit_mismatch","insufficient_data","duplicate","user_excluded"]`
  - `OfferEntry(offer: Offer, normalized_price: Decimal | None, comparison: list[CharComparison], reason: str, exclusion: ExclusionReason | None)`
  - `SkippedPage(url: str, source_id: str, reason: str)` — страница, с которой не удалось извлечь предложение
  - `Stats(n: int, min: Decimal, max: Decimal, mean: Decimal, std: Decimal, cv: Decimal, outlier_rule: str)`
  - `SourceRun(source_id: str, name: str, level: int, queries: list[str], status: Literal["ok","empty","unavailable","error"], error: str | None, found: int, at: datetime)`
  - `PositionReport(position: Position, levels_used: list[int], included: list[OfferEntry], excluded: list[OfferEntry], stats: Stats | None, unit_price: Decimal | None, reference_price: Decimal | None, total: Decimal | None, status: Literal["ok","insufficient","heterogeneous"], assumptions: list[str], skipped_pages: list[SkippedPage], overrides: dict[str, Literal["include","exclude"]] = {})`
  - `Report(procurement_id: str, version: int, created_at: datetime, cause: str, positions: list[PositionReport], sources: list[SourceRun], questions: list[Question], total: Decimal | None, warnings: list[str])`
- Produces (`app/config.py`): `Rules` (pydantic) с полями и значениями по умолчанию `min_prices=3, cv_threshold=Decimal("0.33"), iqr_k=Decimal("1.5"), iqr_min_n=5, median_max_deviation=Decimal("0.5"), level2_trigger_min_prices=3, eis_years=3, max_pages_per_source=8, page_text_limit=15000`; `SourceConfig(id, name, level: int, type: Literal["eis","web"], enabled: bool, params: dict)`; `load_rules(path) -> Rules`; `load_sources(path) -> list[SourceConfig]`; `Settings` (env: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `DATA_DIR=/data`, `CONFIG_DIR`).

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
```

- [ ] **Step 2: `cd backend && pytest -q` — FAIL (нет модулей)**
- [ ] **Step 3: Реализовать модели, конфиг, YAML.** `sources.yaml`: `eis` (level 1, type eis); `web_suppliers` (level 1, type web, `params.query_suffix: "цена производитель дистрибьютор"`); `web_shops` (level 2, type web, `params.sites: [komus.ru, vseinstrumenti.ru, market.yandex.ru, ozon.ru]`). `rules.yaml` — значения по умолчанию из Interfaces. `main.py` — `FastAPI()` с `GET /api/health → {"status":"ok"}`.
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
- Таблица: масса (база мкг): мкг/µg/ug/mcg=1, мг/mg=1000, г/гр/g=10⁶, кг/kg=10⁹; объём (база мл): мл/ml=1, л/l=1000; счётные `шт`(шт./штука/pcs/ед/ед.) — только сами с собой; любые прочие (`пачка`, `упаковка`, `рулон`, `услуга`, `час`, `м2`/`м²`) — равны только сами себе после нормализации (нижний регистр, без точек и пробелов по краям).

- [ ] **Step 1: Тесты**

```python
@pytest.mark.parametrize("s,expected", [
    ("1 290,50 ₽", Decimal("1290.50")), ("12 990 руб.", Decimal("12990")),
    ("1290.5", Decimal("1290.5")), ("от 3 450 ₽", Decimal("3450")), ("15 000", Decimal("15000")),
])
def test_parse_price(s, expected): assert parse_price(s) == expected

def test_parse_price_on_request_raises():
    with pytest.raises(ValueError): parse_price("по запросу")

def test_convert_mass(): assert convert(Decimal("0.05"), "мг", "мкг") == Decimal("50")
def test_convert_alias(): assert convert(Decimal("25"), "µg", "мкг") == Decimal("25")
def test_convert_same_custom_unit(): assert convert(Decimal("5"), "Пачка.", "пачка") == Decimal("5")
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
- Consumes: `convert`, `UnitMismatch` (Task 2); `Offer`, `Basis`, `Stats`, `Rules`.
- Produces:
  - `normalize_price(offer: Offer, basis: Basis) -> Decimal` = `(price + (delivery_cost если delivery == "separate" и задана, иначе 0)) / convert(amount, amount_unit, basis.unit) * basis.per_tz_unit`, округление до 0.01. Пробрасывает `UnitMismatch`.
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

def test_normalize_adds_separate_delivery():
    o = offer(price="1000", amount="1", unit="шт", delivery="separate", delivery_cost="500")
    assert normalize_price(o, Basis(unit="шт", per_tz_unit=Decimal(1))) == Decimal("1500.00")

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

- [ ] **Step 2: FAIL**
- [ ] **Step 3: Реализовать** (границы IQR допустимо считать во float — на результат влияет только членство в выборке).
- [ ] **Step 4: PASS**
- [ ] **Step 5: Commit** `feat: нормализация цен и расчёт НМЦК`

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
- Produces: `ParsedTZ(title: str, positions: list[Position], questions: list[Question])`; `async def parse_tz(llm: LLM, tz_text: str) -> ParsedTZ`; `async def apply_answer(llm: LLM, position: Position, question: Question, answer: str) -> Position`.
- Промпт фиксирует: существенные характеристики = влияющие на цену/сопоставимость (модель, формат, плотность, масса, чистота, …), прочие — `essential=false`; `basis` — единица сравнения цены (для «шт. не менее 10 мкг» → `{unit:"мкг", per_tz_unit:10}`; для пачек → `{unit:"пачка", per_tz_unit:1}`); вопрос задаётся только при реальной неоднозначности, всегда с `default_answer`, который уже отражён в позиции. `Question.id` = `q{position_index}-{n}`.

- [ ] **Step 1: Тесты**

```python
async def test_parse_tz_builds_positions():
    llm = FakeLLM([{"title": "Бумага", "positions": [paper_pos_json()], "questions": []}])
    r = await parse_tz(llm, "текст")
    assert r.positions[0].quantity == Decimal(2500) and r.positions[0].basis.unit == "пачка"

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
  - `SourceResult(pages: list[CandidatePage], run: SourceRun)`
  - `class SourceAdapter(Protocol)`: атрибуты `id: str, name: str, level: int`; `async def search(self, position: Position, rules: Rules) -> SourceResult` — **никогда не бросает**: любые ошибки → `run.status` `unavailable` (сеть/таймаут/5xx) или `error` (прочее) с текстом в `run.error`; 0 страниц → `empty`.
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

**Files:**
- Create: `backend/app/sources/eis.py`, `backend/app/sources/registry.py`; фикстуры `backend/tests/fixtures/eis_search.html`, `backend/tests/fixtures/eis_contract.html`
- Test: `backend/tests/test_eis.py`, `backend/tests/test_registry.py`

**Interfaces:**
- Consumes: `fetch_page`, `SourceAdapter`, `SourceResult`.
- Produces:
  - `EisSource(cfg: SourceConfig, http: httpx.AsyncClient)`: поиск по `https://zakupki.gov.ru/epz/contract/search/results.html` (ключевые слова = название позиции; фильтр 44-ФЗ, стадия «исполнение завершено», дата заключения за последние `rules.eis_years` лет; ОКПД2 позиции, если есть). `parse_search_results(html: str) -> list[str]` — абсолютные URL карточек контрактов. Для каждого контракта загружается страница с перечнем объектов закупки (товары, ед., цена за ед.) и отдаётся как `CandidatePage`; цены из неё извлекает общий `extract_offers` (Task 9), поэтому изменение вёрстки карточки не ломает адаптер.
  - `build_adapters(sources: list[SourceConfig], search: WebSearch, http: httpx.AsyncClient) -> dict[int, list[SourceAdapter]]` — только `enabled`, по уровням.

- [ ] **Step 1: Сохранить реальные страницы.** Открыть поиск ЕИС по «бумага SvetoCopy» с фильтрами выше, сохранить HTML выдачи и одной карточки контракта (вкладка с объектами закупки) в фикстуры. Точные параметры URL и путь вкладки взять из адресной строки браузера и записать константами в `eis.py`.
- [ ] **Step 2: Тесты**

```python
def test_parse_search_results_returns_contract_urls():
    urls = parse_search_results((FIX / "eis_search.html").read_text())
    assert urls and all(u.startswith("https://zakupki.gov.ru/epz/contract/") for u in urls)

async def test_eis_unavailable_is_status_not_exception(respx_mock):
    respx_mock.get(url__startswith="https://zakupki.gov.ru").mock(side_effect=httpx.ConnectTimeout("t"))
    r = await EisSource(cfg_eis(), httpx.AsyncClient()).search(paper_position(), Rules())
    assert r.run.status == "unavailable"

def test_registry_groups_by_level():
    a = build_adapters(load_sources(Path("config/sources.yaml")), FakeSearch(), httpx.AsyncClient())
    assert {x.id for x in a[1]} == {"eis", "web_suppliers"} and {x.id for x in a[2]} == {"web_shops"}
```

- [ ] **Step 3: FAIL** → **Step 4: Реализовать** → **Step 5: PASS**
- [ ] **Step 6: Commit** `feat: адаптер ЕИС и реестр источников`

---

### Task 9: Извлечение предложений и сопоставление

**Files:**
- Create: `backend/app/pipeline/extract.py`, `backend/app/pipeline/match.py`; промпты `EXTRACT_SYSTEM`, `MATCH_SYSTEM`
- Test: `backend/tests/test_extract.py`, `backend/tests/test_match.py`

**Interfaces:**
- Consumes: `LLM`, `parse_price`, `CandidatePage`, `Position`, `Offer`, `CharComparison`.
- Produces:
  - `ExtractFailure(page: CandidatePage, reason: str)`
  - `async def extract_offers(llm: LLM, position: Position, page: CandidatePage, source: SourceAdapter) -> tuple[list[Offer], list[ExtractFailure]]` — LLM возвращает строки (`price`, `amount`, `amount_unit`, `vat`, `delivery`, `delivery_cost`, `price_date`, `title`, `characteristics`) только для предложений, относящихся к позиции; код парсит числа; непарсимая цена → `ExtractFailure` с причиной «цена не указана или не распознана»; `LLMFormatError` → один `ExtractFailure` на страницу. `Offer.id` = sha1(url + title + price)[:12]; `retrieved_at` = `page.retrieved_at`.
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
  - `async def research_position(position: Position, adapters: dict[int, list[SourceAdapter]], llm: LLM, rules: Rules, emit: Emit) -> tuple[PositionReport, list[SourceRun]]`:
    1. уровень 1: адаптеры параллельно (`asyncio.gather`), извлечение, дедуп (дубли → `duplicate`), сравнение+`decide` (исключение с типом и причиной из `decide`), нормализация (`UnitMismatch` → исключение `unit_mismatch`), `find_outliers` по включённым (выбросы → `anomalous_price` с текстом правила);
    2. если включённых < `rules.level2_trigger_min_prices` — то же для уровня 2, затем выбросы и расчёт по объединённой выборке (выбросы пересчитываются заново по объединению);
    3. `calculate` → `unit_price`, `total = unit_price × quantity` (округл. 0.01); `ExtractFailure` → `skipped_pages` (предложение без цены не создаётся).
    4. `emit(progress)` на старте каждого источника и уровня.
  - `recalculate_position(pr: PositionReport, rules: Rules) -> PositionReport` — без сети и LLM: заново применяет `overrides` (`exclude` → `user_excluded`; `include` → возвращает в выборку предложение, исключённое как `incomparable`/`insufficient_data`), выбросы и расчёт.
  - `assemble_report(procurement_id: str, version: int, cause: str, positions: list[PositionReport], sources: list[SourceRun], questions: list[Question]) -> Report` — `total` = сумма `total` позиций, если у всех `status == "ok"`, иначе `None`; `warnings` — по каждой позиции не `ok`: «Позиция N «…»: найдено K цен, обоснование недостаточно» / «…: выборка неоднородна (CV = X %)»; плюс источники `unavailable`/`error`.
  - `async def run_research(procurement_id: str, parsed: ParsedTZ, adapters, llm, rules, emit, version: int) -> Report` — позиции параллельно, вопросы попадают в `Report.questions`, для неотвеченных — `assumptions` «Принято по умолчанию: <default_answer>».

- [ ] **Step 1: Тесты (FakeAdapter, FakeLLM)**

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

def test_report_total_none_if_any_position_not_ok():
    rep = assemble_report("p", 1, "run", [ok_pr(total="725000.00"), insufficient_pr()], [], [])
    assert rep.total is None and len(rep.warnings) == 1
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
- Produces: `render_docx(report: Report, title: str) -> bytes` — разделы из спецификации §5.7: «Предмет закупки», «Где искали», «Включённые предложения» (источник, ссылка, дата получения, исходная цена и ед., приведённая цена, причина), «Исключённые предложения», «Расчёт» (правило выбросов, n, мин, макс, среднее, СКО, CV, НМЦК за ед. и по позиции, итог), «Предупреждения». Оформление — минимальное; финальный вид отчёта решит команда.

- [ ] **Step 1: Тест**

```python
def test_docx_contains_sections_and_links():
    doc = Document(io.BytesIO(render_docx(make_sample_report(), "Бумага")))
    text = "\n".join(p.text for p in doc.paragraphs) + "\n".join(c.text for t in doc.tables for r in t.rows for c in r.cells)
    for h in ["Предмет закупки", "Где искали", "Включённые предложения", "Исключённые предложения", "Расчёт", "Предупреждения"]:
        assert h in text
    assert "https://" in text and "290,00" in text   # деньги в русском формате
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
  - `README.md`: требования (Docker 24+, Docker Compose v2, ключ OpenRouter), запуск `cp .env.example .env && docker compose up -d --build`, остановка `docker compose down`, переменные окружения, внешние сервисы (OpenRouter, zakupki.gov.ru, сайты из `sources.yaml`), как менять источники и правила (YAML), CLI, ≥ 2 use case (бумага, цитокины) с входом и ожидаемым результатом из `docs/examples/`.
  - `docs/architecture.md`: компоненты, поток данных от ТЗ до отчёта (диаграмма mermaid), каскад, разделение LLM/код, правило выбросов, обработка отказов источников.
- [ ] **Step 7: Проверка чистого запуска:** `git clone` в пустую папку → шаги README → `curl localhost:8000/api/health` → ok.
- [ ] **Step 8: Commit** `docs: README, архитектура, use cases, CLI`
