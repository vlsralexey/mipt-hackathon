# mipt-hackathon

Локальный агент для обоснования НМЦК по техническому заданию: поиск предложений,
сопоставление характеристик, расчёт и отчёт с источниками.

## Разработка

- [Актуальный план бэкенда и состояние этапов](docs/backend-roadmap.md).
- [API-контракт с фронтендом](docs/api.md).
- [Описание продукта](PRODUCT.md).
- [Правила работы с репозиторием](AGENTS.md).

Сейчас реализован этап 0: каркас FastAPI и проверка состояния. Поиск, расчёт,
хранилище закупок и чат будут добавлены на следующих этапах. Доступен только
`GET /api/health`; остальные маршруты в контракте — план реализации.

## Запуск в Docker

Нужны Docker Engine или Docker Desktop и Docker Compose. Все команды выполняются
из корня репозитория. Для каркаса `.env` и ключ OpenRouter не требуются.

```bash
docker compose up --build --wait
curl --fail http://localhost:8000/api/health
```

Ответ: `{"status":"ok"}`. Документация API: <http://localhost:8000/docs>.
Фронтенд пока не подключён; порт 8000 обслуживает только бэкенд.

```bash
docker compose logs -f backend
docker compose down
```

Данные хранятся в именованном томе `nmck-data`, в контейнере — `/data`.
Обычный `down` сохраняет том. `docker compose down -v` удаляет данные.
Порт доступен только с локальной машины. При занятом порте:

```bash
BACKEND_PORT=8001 docker compose up --build --wait
```

## Локальная разработка

Нужны [uv](https://docs.astral.sh/uv/) и Python 3.12 (uv может установить его
автоматически). Окружение и зависимости фиксируются в `backend/uv.lock`.

```bash
uv sync --project backend --locked
uv run --project backend --locked uvicorn app.main:app --reload --reload-dir backend/app --host 127.0.0.1 --port 8000
```

Для остановки — `Ctrl+C`. Альтернатива через Make: `make setup`, `make dev`.
Локальные данные создаются в `./data/`; конфиги — в `./data/config/`. На этапе 0
создаются только каталоги: схема и файл SQLite появятся на этапе хранения.

## Переменные окружения и внешние сервисы

При необходимости скопируйте `.env.example` в `.env`. Не перезаписывайте уже
существующий `.env`. Локальное приложение читает `.env` из корня репозитория;
переменные процесса имеют приоритет. Docker Compose берёт ключ, модель и порт
из окружения или `.env`; каталог данных в контейнере всегда `/data`.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `OPENROUTER_API_KEY` | пусто | Ключ OpenRouter для будущих LLM-запросов |
| `OPENROUTER_MODEL` | пусто | Идентификатор модели; будет выбран на этапе 1 |
| `DATA_DIR` | `./data` локально, `/data` в Docker | Постоянные данные |
| `CONFIG_DIR` | `<DATA_DIR>/config` | Локальный путь к методическим конфигам |
| `BACKEND_PORT` | `8000` | Порт Docker на хосте |

Каркас не обращается к внешним сервисам. Загрузка зависимостей и сборка образа
требуют сети. На следующих этапах будут подключены OpenRouter, ЕИС и открытые
сайты поставщиков. Секреты и локальные данные исключены из Git и Docker-контекста.

## Проверки

```bash
make check
```

Без Make:

```bash
uv run --project backend --locked ruff check backend
uv run --project backend --locked ruff format --check backend
uv run --project backend --locked pytest backend/tests -q
```

Тесты используют временные каталоги и не требуют ключей или сети.
`make format` применяет автоформатирование; `make docker-up` и `make docker-down`
управляют контейнером. Доменные зависимости добавляем по мере реализации этапов
и коммитим изменения `backend/pyproject.toml` вместе с `backend/uv.lock`.
