# mipt-hackathon

Локальный агент для обоснования НМЦК по техническому заданию: поиск предложений,
сопоставление характеристик, расчёт и отчёт с источниками.

## Разработка

- [Актуальный план бэкенда и состояние этапов](docs/backend-roadmap.md).
- [API-контракт с фронтендом](docs/api.md).
- [Описание продукта](PRODUCT.md).
- [Идеи на будущее](docs/future-ideas.md).
- [Правила работы с репозиторием](AGENTS.md).

Реализованы расчётное ядро, поиск в ЕИС и вебе, SQLite, REST/SSE, чат с правками
и версиями отчёта, экспорт DOCX и CLI. Описание: [ядро](docs/backend-core.md),
[поиск](docs/backend-search.md), [API и чат](docs/backend-api.md),
[архитектура](docs/architecture.md). Состояние живых проверок: в маршруте бэкенда.
Маршруты P0 из контракта доступны; P1/P2 остаются планом развития.

## Запуск в Docker

Нужны Docker Engine или Docker Desktop и Docker Compose. Все команды выполняются
из корня репозитория. Для запуска и тестов `.env` и ключ OpenRouter не требуются.

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
Локальные данные создаются в `./data/`; конфиги — в `./data/config/`.
Недостающие YAML копируются из `backend/config/` при запуске; существующие
сохраняются. SQLite создаётся в `data/nmck.sqlite3`: закупки, чат, исходные
результаты поиска, правки, неизменные версии и очередь сообщений.

## Переменные окружения и внешние сервисы

При необходимости скопируйте `.env.example` в `.env`. Не перезаписывайте уже
существующий `.env`. Локальное приложение читает `.env` из корня репозитория;
переменные процесса имеют приоритет. Docker Compose берёт ключ, модель и порт
из окружения или `.env`; каталог данных в контейнере всегда `/data`.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `OPENROUTER_API_KEY` | пусто | Ключ OpenRouter для LLM-запросов |
| `OPENROUTER_MODEL` | `openai/gpt-4.1-mini` | Модель OpenRouter; пустое значение выбирает модель по умолчанию |
| `DATA_DIR` | `./data` локально, `/data` в Docker | Постоянные данные |
| `CONFIG_DIR` | `<DATA_DIR>/config` | Локальный путь к методическим конфигам |
| `BACKEND_PORT` | `8000` | Порт Docker на хосте |

Запуск и расчётное ядро не обращаются к внешним сервисам. Клиент OpenRouter
использует сеть только при явном LLM-запросе. Поисковый прогон обращается к
OpenRouter, ЕИС и сайтам поставщиков; загрузка зависимостей и сборка образа
тоже требуют сети. Секреты и локальные данные исключены из Git и Docker-контекста.

HTTP-клиент ЕИС включает публичный корневой сертификат НУЦ Минцифры только для
`zakupki.gov.ru`, с проверкой цепочки и имени хоста. Доверие системы и остальных
сайтов не меняется. Chromium и установка CA в его профиль относятся к P1.

В `cpi.yaml` пока нет подтверждённого полного ряда ИПЦ Росстата: при проверке
источник был недоступен. Старые цены получают пояснение об отсутствии индексов.
Перед живым расчётом их нужно загрузить; подробности — в описании ядра.

## API и чат

Сначала настройте ключ через `PUT /api/settings` или `OPENROUTER_API_KEY`.
Сохранённый через API ключ имеет приоритет над окружением и никогда не возвращается
в ответах. Пустая строка удаляет сохранённый ключ, после чего действует окружение.
Модель также меняется через настройки. Приложение и сохранённые отчёты доступны без ключа.

Создание закупки не запускает поиск и не передаёт ТЗ наружу:

```bash
curl --fail -F 'file=@backend/tests/fixtures/ТЗ поставка бумаги.docx' \
  -F 'message=Обоснуй НМЦК по этому ТЗ' http://localhost:8000/api/procurements
```

Подставьте `id` из ответа в переменную:

```bash
PROCUREMENT_ID='id из ответа'
curl --fail -X POST "http://localhost:8000/api/procurements/$PROCUREMENT_ID/run"
curl -N "http://localhost:8000/api/procurements/$PROCUREMENT_ID/events"
curl --fail "http://localhost:8000/api/procurements/$PROCUREMENT_ID/reports/latest"
curl --fail "http://localhost:8000/api/procurements/$PROCUREMENT_ID/reports/latest/export.docx" -o report.docx
```

Через `POST …/messages` можно спросить о расчёте, исключить или вернуть предложение,
исправить исходные данные, ответить на вопрос, отменить правку и повторить поиск
одной позиции. Один ход агента с несколькими правками создаёт одну версию.
Кнопки ответа и отмены работают по тому же пути. Чат доступен во время поиска.
Примеры запросов и правила SSE: [контракт API](docs/api.md).

Фронтенд запускается отдельно через `make frontend-dev`, Vite проксирует `/api`
на порт 8000. В текущем каркасе включены MSW-моки: подключение UI к реальному API
остаётся отдельной задачей фронтенда.
Для отключения моков: `VITE_MOCKS=off npm run dev --prefix frontend`.

## CLI

Тот же сценарий сохраняет закупку в SQLite и может записать оба формата отчёта:

```bash
uv run --project backend --locked python -m app.cli run \
  'backend/tests/fixtures/ТЗ поставка бумаги.docx' \
  --out data/paper.json --docx data/paper.docx
```

В Docker исходные ТЗ подключаются отдельно: фикстуры не входят в образ.

```bash
docker compose run --rm -v "$PWD/backend/tests/fixtures:/fixtures:ro" backend \
  python -m app.cli run '/fixtures/ТЗ поставка цитокинов.docx' \
  --out /data/cytokines.json --docx /data/cytokines.docx
```

Код выхода: `0` при сформированном отчёте, в том числе при недостатке цен;
`2`, если ключ не задан; `1` при ошибке или тайм-ауте. `--timeout` ограничивает поиск
(по умолчанию 900 секунд). Частичные данные и сообщения остаются в закупке.

Сценарии: [бумага, цитокины и 3D-принтер](docs/examples/README.md).

## Проверочный прогон конвейера

Добавьте `OPENROUTER_API_KEY=...` в локальный `.env` в корне репозитория.
Не присылайте ключ в чат и не добавляйте его в Git. Прогон передаёт текст ТЗ и
данные страниц в OpenRouter; веб-поиск также использует OpenRouter.

```bash
uv run --project backend --locked python -m app.pipeline.preview \
  'backend/tests/fixtures/ТЗ поставка бумаги.docx' \
  --out data/paper --max-pages 3
```

`--max-pages` ограничивает страницы каждого источника для каждой позиции;
без него используется `max_pages_per_source` из правил (8). В `data/paper/`:
`parsed.json`, `snapshot.json`, `runs.json` с исходными ценами и `report.json`.
Недоступный источник или нехватка цен дают предупреждения и `total: null`.
Справочное среднее не выдаётся за обоснованную НМЦК.

Только разбор, без поиска: `--parse-only`. Для поиска по сохранённым позициям:
`--parsed data/paper/parsed.json` вместо пути ТЗ. `--position 1` ограничивает
прогон одной позицией; такой отчёт не представляет всю закупку.
Это низкоуровневый проверочный запуск без SQLite и истории чата; пользовательский
сценарий выше использует `app.cli` или API.

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
