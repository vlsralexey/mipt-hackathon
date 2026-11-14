# API: контракт фронтенда и бэкенда

Дата: 2026-11-14
Статус: начальная версия, по ней начинают фронтенд и бэкенд.
Основа: спека `docs/superpowers/specs/2026-11-13-nmck-agent-design.md`, спека правок
`docs/superpowers/specs/2026-11-14-report-edits-design.md` (§8), план
`docs/superpowers/plans/2026-11-13-nmck-backend-p0.md` (Tasks 1, 11–14), макет `design/main-screen.html`.

Примеры ответов лежат в `docs/api-examples/`: фронтенд берёт их как моки, бэкенд проверяет их
своими моделями (§9).

**Как менять контракт.** Сначала правка этого файла и примеров, потом код. Если реализация
разошлась с контрактом, правится контракт отдельным коммитом, а не молча код.

Пометки: **P0** — нужно для основного сценария; **P1**, **P2** — по приоритетам спеки.
Эндпоинты P1 описаны заранее, чтобы фронтенд закладывал под них место, но бэкенд в P0 их не делает.

## 1. Общие правила

- Все пути начинаются с `/api`. Фронтенд всегда ходит на относительный `/api/...` с того же
  адреса: в разработке Vite проксирует `/api` на `http://localhost:8000`, в Docker — тот же
  принцип. CORS не нужен. Авторизации нет: инструмент локальный.
- Тела запросов и ответов — JSON в UTF-8, кроме загрузки ТЗ (multipart) и выгрузки DOCX.
- **Деньги и дробные числа — строки.** `Decimal` в pydantic v2 сериализуется строкой: `"304.50"`,
  `"1.22"`, `"2500"`. Деньги (`Money`) бэкенд всегда отдаёт с двумя знаками после точки.
  Фронтенд числа только форматирует (`304,50 ₽`) и **ничего денежного не считает сам**: суммы,
  средние, итоги, разницу «было → стало» даёт бэкенд. Считать штуки (сколько предложений в
  таблице) фронтенду можно.
- Даты — `"2026-11-13"`; дата и время — ISO 8601 с часовым поясом: `"2026-11-13T10:20:00+03:00"`.
- Идентификаторы — непрозрачные строки. Фронтенд не разбирает их и не строит сам.
- Все тексты для пользователя (причины, предупреждения, статусы, ошибки) — на русском, готовы к
  показу. Фронтенд не переводит коды в тексты, кроме подписей статусов (§6.4).
- В текстах для пользователя нет длинных тире (— и –): вместо них двоеточие, запятая, точка или
  союз, диапазоны через дефис («142-148 %»). Это правило проекта, а не вкус фронтенда: тексты
  показываются как пришли, и фронтенд их не правит.
- Поле, которого нет в ответе, и поле `null` значат одно и то же. Бэкенд отдаёт поля всегда,
  со значением `null`, если данных нет.
- Неизвестные поля фронтенд игнорирует: бэкенд может добавлять поля без правки контракта.
  Удалить или переименовать поле — только правкой контракта.

### Ошибки

Любая ошибка — `{"detail": "<текст для пользователя>"}`. Ошибки валидации FastAPI (422) бэкенд
тоже приводит к этому виду, отдельным обработчиком `RequestValidationError`.

| Код | Когда |
|---|---|
| 400 | Неверные данные: неподдерживаемый формат файла, пустое ТЗ, нет ключа OpenRouter при запуске |
| 404 | Нет такой закупки, версии, вопроса, правки |
| 409 | Действие сейчас невозможно: поиск уже идёт, правка уже отменена, предложение подтверждения устарело |
| 413 | Файл ТЗ больше 20 МБ |
| 422 | Тело запроса не по схеме |
| 500 | Внутренняя ошибка; `detail` — «Внутренняя ошибка сервера», подробности в логах бэкенда |
| 502 | Не удалось получить каталог моделей OpenRouter |

## 2. Как фронтенд пользуется API

**Новая закупка** (кнопка «Новая закупка» → файл + сообщение в поле ввода):
1. `POST /api/procurements` (multipart: `file`, `message`) → `201 Procurement`.
2. Сразу `POST /api/procurements/{id}/run` → `202`. При `400` (нет ключа) — показать `detail`
   и ссылку на «Настройки»; закупка уже создана, запуск можно повторить.
3. Открыть `GET /api/procurements/{id}/events` (SSE) и показывать приходящие сообщения.

**Экран закупки:**
1. `GET /api/procurements/{id}` — заголовок, статус, вся история чата.
2. SSE `…/events`. Событие `message` — вставить сообщение или заменить по `id` (ход поиска,
   вопросы и карточки обновляются этим же событием). Событие `report` — перезапросить
   `GET …/reports/latest`, если пользователь смотрит последнюю версию.
3. Если `latest_version != null` — `GET …/reports/latest` в панель отчёта.

**Переподключение.** `EventSource` переподключается сам. На каждый `open` фронтенд заново
запрашивает `GET /api/procurements/{id}`: события между обрывом и подключением не
переигрываются, а все события — замены по `id`, поэтому повторное получение безопасно.

**Чат.** `POST …/messages` → `202` с сохранённым сообщением пользователя (его же затем пришлёт
SSE — замена по `id`, не дубль). Ответ агента приходит событиями `message`; пока агент думает,
`agent {busy: true}`. Сообщения можно отправлять и во время поиска и пока агент занят: бэкенд
ставит их в очередь и обрабатывает по порядку.

**Кнопки без LLM:** ответ на уточняющий вопрос (`…/questions/{qid}/answer`), «Отменить» в
карточке версии и в разделе «Правки пользователя» (`…/edits/cancel`). Результат приходит так же,
как от агента: новая карточка версии и событие `report`.

**Список закупок** в навигации — `GET /api/procurements`; перезапрашивать по событию
`procurement` открытой закупки и после создания новой.

## 3. Эндпоинты

| | Метод и путь | Что делает | Ответ |
|---|---|---|---|
| P0 | `GET /api/health` | Проверка, что бэкенд жив | `{"status": "ok"}` |
| P0 | `GET /api/settings` | Настройки: есть ли ключ, модель | `Settings` |
| P0 | `GET /api/settings/models` | Актуальный каталог текстовых моделей OpenRouter | `OpenRouterModel[]` |
| P0 | `PUT /api/settings` | Сохранить ключ и/или модель | `Settings` |
| P1 | `POST /api/settings/check` | Проверить ключ запросом к OpenRouter | `{"ok": bool, "detail": str \| null}` |
| P0 | `GET /api/procurements` | Список закупок, новые сверху | `ProcurementSummary[]` |
| P0 | `POST /api/procurements` | Создать закупку из ТЗ | `201 Procurement` |
| P0 | `GET /api/procurements/{id}` | Закупка с историей чата | `Procurement` |
| P2 | `DELETE /api/procurements/{id}` | Удалить закупку | `204` |
| P0 | `POST /api/procurements/{id}/run` | Запустить первый прогон | `202 {"run_id": str}` |
| P0 | `GET /api/procurements/{id}/events` | Поток событий (SSE), §4 | `text/event-stream` |
| P0 | `POST /api/procurements/{id}/messages` | Сообщение агенту | `202 Message` |
| P0 | `POST /api/procurements/{id}/questions/{question_id}/answer` | Ответ на вопрос кнопкой | `202` |
| P0 | `GET /api/procurements/{id}/reports` | Версии отчёта, по возрастанию | `VersionInfo[]` |
| P0 | `GET /api/procurements/{id}/reports/{version}` | Отчёт версии; `version` — число или `latest` | `Report` |
| P0 | `GET /api/procurements/{id}/reports/{version}/export.docx` | Отчёт в DOCX | файл |
| P1 | `GET /api/procurements/{id}/reports/{a}/diff/{b}` | Разница версий | `VersionDiff` |
| P0 | `GET /api/procurements/{id}/edits` | Правки пользователя | `Edit[]` |
| P0 | `POST /api/procurements/{id}/edits/cancel` | Отменить правки одной новой версией | `202` |
| P1 | `POST /api/procurements/{id}/proposals/{proposal_id}/apply` | «Применить» в карточке подтверждения | `202` |
| P1 | `POST /api/procurements/{id}/proposals/{proposal_id}/reject` | «Отмена» в карточке подтверждения | `200` |
| P1 | `POST /api/procurements/{id}/sources/{source_id}/skip` | «Пропустить источник» (капча, вход) | `202` |
| P1 | `GET /api/procurements/{id}/settings` | Вкладка «Локальные настройки» | `LocalSettings` |
| P1 | `POST /api/procurements/{id}/settings/rebase` | «Пересчитать по общим» | `202` |
| P1 | `GET /api/config` | Общие источники и правила | `Config` |
| P1 | `GET /api/config/changes` | Журнал изменений общих настроек | `ConfigChange[]` |
| P1 | `GET /api/config/messages` | История чата агента настроек | `Message[]` |
| P1 | `POST /api/config/messages` | Сообщение агенту настроек | `202 Message` |
| P1 | `GET /api/config/events` | SSE агента настроек | `text/event-stream` |
| P1 | `POST /api/config/proposals/{proposal_id}/apply` · `…/reject` | Карточка «было → стало» | `202` / `200` |
| P1 | `POST /api/config/changes/{change_id}/cancel` | Отменить изменение из журнала | `202` |
| P1 | `WS /api/browser` | Живое окно браузера, §3.6 | WebSocket |

`202` значит «принято, результат придёт событиями». Тело у `202` без указанного типа — `{}`.

### 3.1 Настройки (P0)

`GET /api/settings` → `Settings`. Ключ не возвращается никогда, даже частично.

`PUT /api/settings` — частичное обновление, только переданные поля:

```json
{"openrouter_api_key": "sk-or-v1-…", "model": "<идентификатор модели с openrouter.ai/models>"}
```

`openrouter_api_key: ""` удаляет сохранённый ключ (тогда действует `OPENROUTER_API_KEY` из
окружения, если задан). Ответ — `Settings` после сохранения.

`GET /api/settings/models` загружает публичный каталог через
[`GET https://openrouter.ai/api/v1/models`](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
Ключ не нужен. Ответ: массив `{"id": str, "name": str}`, отсортированный по названию,
только модели с текстовым входом и выходом для Chat Completions. Пример:

```json
[{"id": "openai/gpt-4.1-mini", "name": "OpenAI: GPT-4.1 Mini"}]
```

При недоступности OpenRouter или некорректном ответе: `502` с безопасным `detail`.
Фронтенд предлагает повторить загрузку, сохраняет текущую модель и позволяет
ввести ID вручную. Выбранный ID сохраняется прежним `PUT /api/settings`.
Каталог не гарантирует доступность модели для конкретного ключа и поддержку
всех возможностей агента (структурированные ответы и инструменты).

### 3.2 Закупки (P0)

`POST /api/procurements` — `multipart/form-data`:

| Поле | Обязательно | Что это |
|---|---|---|
| `file` | `file` или `tz_text` | ТЗ: `.docx`, `.pdf`, `.txt`, `.md`, до 20 МБ |
| `tz_text` | `file` или `tz_text` | Текст ТЗ, если файла нет (вставили в поле ввода) |
| `message` | нет | Сообщение пользователя рядом с файлом («Обоснуй НМЦК по этому ТЗ.») — сохраняется в чат |

Текст из файла извлекается сразу: неподдерживаемый формат или пустой текст → `400`.
`title` новой закупки — имя файла без расширения (или «Новая закупка»); после разбора ТЗ бэкенд
заменяет его названием из ТЗ и шлёт событие `procurement`. В истории чата новой закупки —
сообщение `file` (или `text` с ТЗ) и, если передано, `message` пользователя.

`POST /api/procurements/{id}/run` — первый прогон: разбор ТЗ → вопросы → поиск → версия 1.
Ход виден в чате сообщениями `tz_summary`, `question`, `run`, `version`.
- `400 {"detail": "Не задан ключ OpenRouter. Укажите его в настройках."}`
- `409` — поиск уже идёт или первый прогон уже был. Повторный поиск запускает агент по просьбе
  в чате («начни заново», «поищи ещё»).
- Недействительный ключ выясняется уже в фоне: сообщение `error` с текстом
  «Ключ OpenRouter недействителен» и `code: "llm_auth"`, статус закупки — `failed`; после
  исправления ключа `run` можно вызвать снова.

### 3.3 Чат и вопросы (P0)

`POST /api/procurements/{id}/messages`:

```json
{"text": "Исключи контракт 3810, там б/у", "viewing_version": 2}
```

`viewing_version` — версия, открытая в панели отчёта (необязательно). Агент по нему понимает,
о какой таблице говорит пользователь, и предупреждает, если правка ушла в более новую версию.

`POST /api/procurements/{id}/questions/{question_id}/answer`:

```json
{"answer": "Да, учитывать аналоги"}
```

`answer` — одна из `Question.options` или свой текст. Ответить можно до первой версии, во
время поиска и повторно (новый ответ вытесняет старый). Сообщение вопроса обновляется
событием `message` (заполнено `answer`), затем приходит карточка версии.

### 3.4 Отчёт и версии (P0)

`GET …/reports` → `VersionInfo[]` для списка версий в шапке панели.

`GET …/reports/{version}` → `Report`. Нет ни одной версии → `404`.

`GET …/reports/{version}/export.docx` → `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
`Content-Disposition: attachment; filename*=UTF-8''<НМЦК — название — версия N>.docx`.
Фронтенд открывает ссылку как обычную загрузку.

### 3.5 Правки (P0)

`GET …/edits` → `Edit[]` в порядке `seq`, включая отменённые и вытесненные.

`POST …/edits/cancel`:

```json
{"edit_ids": ["ed_01"]}
```

Все перечисленные правки отменяются одной новой версией: «Отменить» в карточке версии передаёт
все `VersionCard.edit_ids`, «Отменить» в разделе «Правки пользователя» и «Сбросить» во вкладке
локальных настроек — одну правку. Если какая-то правка уже не `active` — `409`, ничего не
отменяется.

### 3.6 Живое окно браузера (P1)

`WS /api/browser?procurement_id=<id>` показывает все активные вкладки агента
выбранной закупки. Наблюдение не передаёт управление человеку и не останавливает
агента. При переключении закупки клиент закрывает прежнее соединение.

Сервер → клиент:
- `{"type":"tabs","tabs":[{"id":str,"url":str,"title":str,"procurement_id":str,"source_id":str,"status":str,"action":str,"blocked":bool}],"selected_tab_id":str|null}`:
  полный актуальный список, включая открытые сайтом новые вкладки. Статусы:
  `loading`, `reading`, `waiting`, `done`, `error`. `action` содержит краткое
  описание текущего действия на русском. Закрытые вкладки исчезают из списка.
- `{"type":"frame","tab_id":str,"data":"<jpeg base64>","width":1280,"height":800}`:
  периодические кадры выбранной вкладки. Кадры других вкладок клиент игнорирует.
- `{"type":"control","tab_id":str,"by":"agent"|"user"}`: владелец управления.
- `{"type":"error","detail":str}`: безопасная ошибка действия или соединения.

Клиент → сервер (кроме `select`, действия выполняются только после передачи
управления пользователю):
- `{"type":"select","tab_id":str}`: выбрать вкладку для наблюдения;
- `{"type":"control","tab_id":str,"by":"agent"|"user"}`: взять/вернуть управление;
- `{"type":"mouse","tab_id":str,"event":"down"|"up"|"move","x":int,"y":int,"button":"left"|"right"|"middle"}`;
- `{"type":"wheel","tab_id":str,"dx":int,"dy":int}`;
- `{"type":"key","tab_id":str,"event":"down"|"up","key":str}`;
- `{"type":"text","tab_id":str,"text":str}`;
- `{"type":"resume","tab_id":str}`: проверка завершена, вернуть управление агенту.

Координаты задаются в пикселях кадра. Подписки и выбор вкладки независимы у каждого
наблюдателя. Вкладки другой закупки недоступны. При отключении управляющего
клиента управление возвращается агенту. Наблюдение не создаёт новых страниц.

Если нужна капча или вход, источник ждёт человека ограниченное время, остальные
источники продолжают поиск. В чат приходит `source_blocked`; «Открыть браузер»
переключает панель, «Пропустить источник» вызывает
`POST …/sources/{source_id}/skip`. Истечение ожидания и пропуск видны в отчёте.
Профиль Chromium изолирован от браузеров пользователя; сертификаты ЕИС
применяются отдельно, проверка TLS не отключается.

### 3.7 Уточнения P1

`GET …/reports/{a}/diff/{b}` принимает положительные номера версий и возвращает
`VersionDiff`; отсутствие любой версии даёт `404`. Сравнение не создаёт версию.
Применить или отклонить можно только `pending`-предложение; устаревшее действие
даёт `409`. Новая версия делает предложения со старой `base_version` устаревшими.

`POST /api/config/messages` принимает `{"text":str}`, возвращает сохранённое
сообщение пользователя (`202 Message`); результат агента приходит через SSE.
Кнопочный ответ на вопрос сразу подтверждается `202`: интерфейс показывает
выбранный вариант и ожидание применения до обновления вопроса по SSE.

## 4. События (SSE)

`GET /api/procurements/{id}/events` — `text/event-stream`, формат каждого события:

```
event: message
data: {"id": "m_07", "kind": "run", …}

```

Бэкенд раз в 15 секунд шлёт комментарий-пинг (`sse-starlette` делает это сам) и ставит заголовок
`X-Accel-Buffering: no`. Порядок событий внутри потока сохраняется.

| Событие | `data` | Когда | Что делает фронтенд |
|---|---|---|---|
| `message` | `Message` | Новое сообщение или изменение существующего (ход поиска, ответ на вопрос, статус карточки) | Вставить или заменить по `id`, сохраняя порядок по `created_at` |
| `report` | `{"version": int, "cause": str}` | Сохранена новая версия отчёта | Обновить список версий; если открыта последняя — загрузить новую |
| `procurement` | `ProcurementSummary` | Изменились название или статус закупки | Обновить шапку и строку в навигации |
| `agent` | `{"busy": bool}` | Агент начал или закончил ход | Индикатор «агент думает» |

Ответ агента приходит целым сообщением; потоковой печати по токенам в P0 нет.

`GET /api/config/events` (P1) — те же `message` и `agent` для агента настроек, плюс
`config {}` — общие настройки изменились, перезапросить `GET /api/config`.

## 5. Модели

Описаны на TypeScript — так их удобно скопировать во фронтенд (`frontend/src/api/types.ts`).
Бэкенд держит те же поля в pydantic (`backend/app/models.py`, Task 1 плана); имена полей
совпадают один в один, `snake_case`.

### 5.1 Базовые типы

```ts
type Money = string;        // Decimal с 2 знаками: "761250.00"
type Dec = string;          // Decimal без фиксированной точности: "1.22", "0.0468", "2500"
type ISODate = string;      // "2026-11-13"
type ISODateTime = string;  // "2026-11-13T10:20:00+03:00"
type Change<T> = { before: T | null; after: T | null };
```

### 5.2 Настройки и закупки

```ts
interface Settings {
  has_api_key: boolean;     // ключ есть в настройках или в env
  key_source: "settings" | "env" | null;
  model: string;            // идентификатор модели OpenRouter
}

interface OpenRouterModel {
  id: string;
  name: string;
}

type ProcurementStatus =
  | "new"         // создана, прогон не запускался
  | "running"     // идёт поиск
  | "needs_user"  // поиск ждёт человека: капча или вход (P1)
  | "ready"       // есть версия отчёта, поиск не идёт
  | "failed";     // прогон упал до первой версии (причина — сообщением error)

interface ProcurementSummary {
  id: string;
  title: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  status: ProcurementStatus;
  latest_version: number | null;
  total: Money | null;            // Report.total последней версии
  total_justified: Money | null;  // Report.total_justified последней версии
  positions_total: number;        // 0, пока ТЗ не разобрано
  positions_unjustified: number;  // позиции со статусом не "ok" в последней версии
}

interface Procurement extends ProcurementSummary {
  filename: string | null;
  agent_busy: boolean;
  messages: Message[];            // вся история по created_at
}

interface VersionInfo {
  version: number;
  created_at: ISODateTime;
  cause: string;                  // «Первый прогон», «Исключено: …»
  total: Money | null;
  total_justified: Money | null;
}
```

Подпись под названием в навигации фронтенд строит сам: `running`: «Идёт поиск»,
`needs_user`: «Нужна ваша помощь», `failed`: «Прогон не удался», иначе дата и время
`updated_at` в часовом поясе пользователя («13 ноября, 10:20»; для прошлых лет с годом).
Число позиций без обоснования в навигации не показывается, оно есть в отчёте.

### 5.3 Сообщения чата

```ts
type Message =
  | MessageBase<"text", null>                  // обычный текст пользователя или агента
  | MessageBase<"file", FileData>              // ТЗ, приложенное пользователем
  | MessageBase<"tz_summary", TzSummary>       // агент разобрал ТЗ
  | MessageBase<"question", Question>          // уточняющий вопрос с кнопками
  | MessageBase<"run", RunState>               // ход поиска (обновляется на месте)
  | MessageBase<"version", VersionCard>        // карточка новой версии отчёта
  | MessageBase<"proposal", Proposal>          // P1: карточка подтверждения
  | MessageBase<"source_blocked", SourceBlocked> // P1: источнику нужна капча или вход
  | MessageBase<"error", ErrorData>;

interface MessageBase<K extends string, D> {
  id: string;
  created_at: ISODateTime;
  role: "user" | "agent" | "system";   // system — карточки, которые публикует код
  kind: K;
  text: string | null;  // текст сообщения; markdown-подмножество: абзацы, списки, **жирный**, ссылки
  data: D;
}

interface FileData { filename: string; size_bytes: number }

interface TzSummary {
  title: string;
  positions: { index: number; name: string; quantity: Dec; unit: string }[];
}

interface ErrorData {
  code: "llm_auth" | "llm_unavailable" | "tz_parse_failed" | "internal";
}
```

У `text`, `file` текст — от пользователя или агента. У `tz_summary`, `question`, `run` текст
может быть пояснением агента над карточкой (`null` — без пояснения). У `version` текст `null`:
всё в `data`.

#### Уточняющий вопрос

```ts
interface Question {
  id: string;               // "q1-1": позиция 1, вопрос 1
  position_index: number;
  text: string;             // «Учитывать аналоги без марки SvetoCopy?»
  hint: string | null;      // пояснение мелким шрифтом
  options: string[];        // кнопки; default_answer всегда среди них
  default_answer: string;   // с ним прогон идёт, пока ответа нет
  answer: string | null;    // null — действует default_answer
}
```

Выбранная кнопка — та, что совпадает с `answer`; если `answer` — свой текст, он показывается
под вопросом. Пока `answer == null`, можно подсветить `default_answer` как «принято по
умолчанию».

#### Ход поиска

Одно сообщение `run` на каждый запуск поиска; бэкенд обновляет его событиями `message` по мере
работы. Свёрнутый вид — `summary`, развёрнутый — `steps`.

```ts
interface RunState {
  run_id: string;
  kind: "full" | "targeted" | "user";   // первый прогон / «поищи ещё» / предложение по ссылке
  state: "running" | "done" | "failed";
  summary: string;                // от кода: «Проверено 4 источника, подходят 8 цен»
  position_indexes: number[];     // по каким позициям этот поиск
  started_at: ISODateTime;
  finished_at: ISODateTime | null;
  steps: RunStep[];
}

interface RunStep {
  source_id: string;
  name: string;                   // «ЕИС Закупки»
  level: 1 | 2;
  position_index: number;
  status: "queued" | "running" | SourceStatus;
  found: number;                  // сколько предложений извлечено
  relevant: number | null;        // сколько прошло сопоставление; null — ещё не известно
  note: string | null;            // «цены не публикуются», «ждёт проверки», текст ошибки
}

type SourceStatus =
  | "ok" | "empty" | "unavailable" | "error"
  | "needs_login"   // P1: ждёт капчу или вход
  | "skipped";      // P1: пропущен пользователем или без ответа на капчу
```

Шаги идут по паре «источник × позиция». В свёрнутом виде фронтенд может сгруппировать их по
`source_id` и сложить `found` и `relevant` — это счёт штук, не денег.

#### Карточка версии

```ts
interface VersionCard {
  version: number;
  cause: string;
  diff: VersionDiff;
  edit_ids: string[];      // правки этой версии; «Отменить» → POST …/edits/cancel с ними
  cancellable: boolean;    // false у первого прогона и у версии, чьи правки уже отменены
}

interface VersionDiff {
  from_version: number | null;          // null у первой версии
  to_version: number;
  total: Change<Money>;
  total_justified: Change<Money>;
  positions: PositionChange[];          // только изменившиеся позиции
  offers_moved: OfferMove[];            // перешли между включёнными и исключёнными
  edits_added: string[];
  edits_cancelled: string[];
  rules_changed: { key: string; title: string; before: string; after: string }[];  // P1
}

interface PositionChange {
  index: number;
  name: string;
  status: Change<PositionStatus>;
  unit_price: Change<Money>;
  n: Change<number>;
  cv: Change<Dec>;
}

interface OfferMove {
  offer_id: string;
  label: string;           // номер строки в новой версии: "1.5"
  caption: string;
  position_index: number;
  to: "included" | "excluded";
  reason: string;
}
```

#### P1: подтверждение и капча

```ts
interface Proposal {
  id: string;
  text: string;            // «Для этой закупки: выброс — отклонение от медианы больше 25 % вместо 50 %»
  diff: VersionDiff;       // что изменится, если применить
  status: "pending" | "applied" | "rejected" | "expired";
}

interface SourceBlocked {
  source_id: string;
  name: string;
  url: string;
  reason: "captcha" | "login";
  status: "waiting" | "resolved" | "skipped";
}
```

Кнопки «Применить» / «Отмена» показываются только при `status == "pending"`.

### 5.4 Отчёт

Сводка полей — из Task 1 плана и §8 спеки правок; добавления этого контракта перечислены в §8.

```ts
interface Report {
  procurement_id: string;
  version: number;
  created_at: ISODateTime;
  title: string;                  // название закупки из ТЗ
  calc_date: ISODate;             // дата, на которую приводятся цены
  methodology: string;            // текст методики с оговоркой о 44-ФЗ / 223-ФЗ
  cause: string;
  positions: PositionReport[];
  sources: SourceRun[];
  questions: Question[];
  delivery_terms: string | null;  // требование ТЗ к поставке
  delivery_extras: string[];      // разгрузка, занос и т. п.
  total: Money | null;            // итог НМЦК; null, если хоть одна позиция не "ok"
  total_justified: Money | null;  // сумма по позициям "ok"; null, если таких нет
  warnings: string[];
  edits: AppliedEdit[];           // раздел «Правки пользователя»
  rules: Record<string, unknown>; // действующие правила закупки (ключи — как в rules.yaml)
  local_settings: string[];       // P1: чем настройки закупки отличаются от общих
}

type PositionStatus = "ok" | "insufficient" | "heterogeneous";

interface PositionReport {
  position: Position;
  status: PositionStatus;
  levels_used: (1 | 2)[];
  included: OfferEntry[];
  excluded: OfferEntry[];
  stats: Stats | null;            // null, если цен нет
  unit_price: Money | null;       // НМЦК за единицу; только при "ok"
  reference_price: Money | null;  // среднее справочно при "insufficient" / "heterogeneous"
  total: Money | null;            // unit_price × quantity; только при "ok"
  assumptions: string[];          // «Принято по умолчанию: …», «Уровень 2 подключён: …»
  spread_hints: string[];         // подсказки о причине разброса
  skipped_pages: SkippedPage[];
  excluded_by_user: boolean;      // P2: позиция не входит в итог по просьбе пользователя
}

interface Position {
  index: number;                  // с 1
  name: string;
  unit: string;                   // единица ТЗ: «пачка», «шт»
  quantity: Dec;
  okpd2: string | null;           // как в ТЗ, только для показа
  characteristics: Characteristic[];
  basis: { unit: string; per_tz_unit: Dec };  // единица сравнения цены
  search_terms: string[];
}

interface Characteristic {
  name: string;
  value: string;
  unit: string | null;
  essential: boolean;
}

interface Stats {
  n: number;                      // цен в расчёте (после исключения выбросов)
  min: Money;
  max: Money;
  mean: Money;
  std: Money;                     // СКО, n − 1
  cv: Dec;                        // коэффициент вариации долей: "0.0468" = 4,68 %
  outlier_rule: string;           // человекочитаемое правило выбросов
  median: Money;                  // медиана выборки, в которой искали выбросы
  lower_bound: Money | null;      // границы допустимого коридора — для линейки цен
  upper_bound: Money | null;
}

interface OfferEntry {
  label: string;                  // номер строки «позиция.строка»: включённые, затем исключённые
  caption: string;                // как в таблице: «ЕИС, контракт № 2770…0148»
  offer: Offer;
  base_price: Money | null;       // цена за единицу ТЗ до поправок
  vat: VatResolution | null;
  indexation: IndexResolution | null;
  delivery: DeliveryResolution | null;
  normalized_price: Money | null; // расчётная цена
  comparison: CharComparison[];
  reason: string;                 // почему включено или исключено
  exclusion: ExclusionReason | null;
  original: Record<string, string> | null;  // поля до исправления пользователем
  user_marks: ("corrected" | "added" | "excluded" | "excluded_by_price" | "included")[];
}

type ExclusionReason =
  | "anomalous_price" | "incomparable" | "unit_mismatch" | "insufficient_data"
  | "duplicate" | "same_supplier" | "user_excluded";

interface Offer {
  id: string;
  source_id: string;
  source_name: string;
  level: 1 | 2;
  url: string;
  retrieved_at: ISODateTime;
  title: string;
  price: Money;                   // как на странице, за amount amount_unit
  currency: "RUB";
  amount: Dec;
  amount_unit: string;
  vat: "included" | "excluded" | "exempt" | "unknown";
  vat_rate: Dec | null;           // долей: "0.22"
  supplier: string | null;
  supplier_inn: string | null;
  delivery: "included" | "separate" | "unknown";
  delivery_cost: Money | null;
  delivery_free_from: Money | null;
  delivery_note: string | null;
  price_date: ISODate | null;
  characteristics: Record<string, string>;
}

interface VatResolution { status: "included" | "added" | "exempt" | "unknown"; factor: Dec; note: string }
interface IndexResolution { status: "applied" | "not_needed" | "no_data"; factor: Dec; note: string }
interface DeliveryResolution { status: "included" | "added" | "unknown"; added_per_unit: Money; note: string }

interface CharComparison {
  name: string;
  required: string;
  offered: string | null;
  essential: boolean;
  ok: boolean | null;             // null — в предложении нет данных
}

interface SkippedPage { url: string; source_id: string; reason: string }

interface SourceRun {
  source_id: string;
  name: string;
  level: 1 | 2;
  position_index: number;
  queries: string[];
  status: SourceStatus;
  error: string | null;
  found: number;
  at: ISODateTime;
}
```

Цепочка приведения для строки таблицы: `price` за `amount amount_unit` → `base_price` →
× `vat.factor` → × `indexation.factor` → + `delivery.added_per_unit` → `normalized_price`.
Основания — в `note`. Множители, равные `"1"`, и нулевую доставку можно не показывать.

### 5.5 Правки

```ts
type EditKind =
  | "exclude" | "include" | "correct_offer" | "answer_question"   // P0
  | "add_offer" | "exclude_where" | "edit_position" | "local_setting" | "rebase_settings"  // P1
  | "exclude_position";                                            // P2

interface Edit {
  id: string;
  seq: number;
  created_at: ISODateTime;
  kind: EditKind;
  position_index: number | null;
  target: string | null;          // offer_id, question_id или ключ настройки
  payload: Record<string, unknown>;  // по kind, см. спеку правок §6.3
  reason: string;
  reason_kind: "characteristics" | "source" | "date" | "supplier" | "price" | "other" | null;
  origin: "chat" | "button";
  status: "active" | "cancelled" | "superseded";
  summary: string;                // от кода: «Исключено: Дистрибьютор «Регион», каталог — «поставка б/у»»
}

interface AppliedEdit {
  edit: Edit;
  applied: boolean;               // false — цель не найдена при последнем поиске
  effect: string;                 // «Исключено из расчёта» / «Не применена: предложение не найдено при поиске от 14.11.2026»
}
```

Фронтенду для показа достаточно `summary`, `reason`, `status`, `applied`, `effect`; `payload`
нужен агенту и отладке.

### 5.6 P1: локальные и общие настройки

```ts
interface LocalSettings {
  items: LocalSetting[];
  base_outdated: { key: string; title: string; base: string; current: string }[];  // плашка «Общие настройки изменились»
}

interface LocalSetting {
  key: string;                    // "rules.cv_threshold", "sources.web_shops.sites"
  group: "rules" | "sources";
  title: string;                  // «Порог разброса (CV)»
  display: string;                // действующее значение: «40 %»
  global_display: string;         // общее значение: «33 %»
  changed: boolean;
  edit_id: string | null;         // для «Сбросить»
}

interface Config {
  sources: {
    id: string; name: string; level: 1 | 2; type: "eis" | "web"; enabled: boolean;
    sites: string[]; vat_default: "included" | "unknown"; vat_note: string | null;
    delivery_note: string | null;
  }[];
  rules: { key: string; title: string; value: unknown; display: string; description: string }[];
}

interface ConfigChange {
  id: string;
  created_at: ISODateTime;
  path: string;
  title: string;
  before: string;
  after: string;
  reason: string;
  status: "active" | "cancelled";
}
```

Формы `Config` и `LocalSettings` уточняются вместе с макетом страницы «Настройки».

## 6. Подписи кодов

Тексты причин, предупреждений и оснований приходят готовыми. Подписи нужны только для
коротких статусов, которые фронтенд показывает значком или меткой:

| Код | Подпись |
|---|---|
| `PositionStatus.ok` | обоснована |
| `insufficient` | недостаточно цен (цена справочно) |
| `heterogeneous` | неоднородная выборка (цена справочно) |
| `SourceStatus.ok` | найдено |
| `empty` | ничего не найдено |
| `unavailable` | не отвечает |
| `error` | ошибка |
| `needs_login` | ждёт проверки |
| `skipped` | пропущен |
| `RunStep.queued` / `running` | в очереди / ищу |
| `ExclusionReason.anomalous_price` | выброс |
| `incomparable` | не совпадают характеристики |
| `unit_mismatch` | несопоставимая единица |
| `insufficient_data` | недостаточно данных |
| `duplicate` | дубль |
| `same_supplier` | повторная цена поставщика |
| `user_excluded` | исключено вами |

## 7. Примеры

- `docs/api-examples/report.json` — `GET …/reports/1`: бумага, две позиции; позиция 1
  обоснована (3 цены, выброс, несопоставимое предложение), позиция 2 — «недостаточно цен»,
  подключён уровень 2.
- `docs/api-examples/procurement.json` — `GET /api/procurements/{id}` той же закупки: файл,
  разбор ТЗ, вопрос, ход поиска, карточка версии, ответ агента.

Данные в примерах условные: поставщики, номера контрактов и цены выдуманы, домены — `.example`.

Правка и карточка версии после неё (пользователь исключил предложение 1.3 «Регион»):

```json
{
  "id": "ed_01", "seq": 1, "created_at": "2026-11-13T10:31:40+03:00",
  "kind": "exclude", "position_index": 1, "target": "c47a19e05b2f",
  "payload": {"offer_id": "c47a19e05b2f"},
  "reason": "поставка б/у", "reason_kind": "other", "origin": "chat", "status": "active",
  "summary": "Исключено: Дистрибьютор «Регион», каталог — «поставка б/у»"
}
```

```json
{
  "id": "m_09", "created_at": "2026-11-13T10:31:42+03:00", "role": "system", "kind": "version", "text": null,
  "data": {
    "version": 2, "cause": "Исключено: Дистрибьютор «Регион», каталог — «поставка б/у»",
    "edit_ids": ["ed_01"], "cancellable": true,
    "diff": {
      "from_version": 1, "to_version": 2,
      "total": {"before": null, "after": null},
      "total_justified": {"before": "761250.00", "after": null},
      "positions": [{
        "index": 1, "name": "Бумага А4 SvetoCopy, 80 г/м²",
        "status": {"before": "ok", "after": "insufficient"},
        "unit_price": {"before": "304.50", "after": null},
        "n": {"before": 3, "after": 2},
        "cv": {"before": "0.0468", "after": "0.0306"}
      }],
      "offers_moved": [{
        "offer_id": "c47a19e05b2f", "label": "1.5", "caption": "Дистрибьютор «Регион», каталог",
        "position_index": 1, "to": "excluded", "reason": "Исключено вами: поставка б/у"
      }],
      "edits_added": ["ed_01"], "edits_cancelled": [], "rules_changed": []
    }
  }
}
```

## 8. Что контракт добавляет к плану бэкенда

Бэкенд реализует Task 12 по этому файлу. Отличия от плана и спеки правок:

**Модели (Task 1)**
- `Report`: `title`, `total_justified` (в макете «НМЦК по обоснованным позициям» при
  необоснованной позиции; фронтенд деньги не складывает).
- `Stats`: `median`, `lower_bound`, `upper_bound` — линейка цен с коридором в макете. Для правила
  медианы границы — `медиана × (1 ∓ median_max_deviation)`, для IQR — `Q1 − k·IQR`, `Q3 + k·IQR`.
- `SourceRun`: `position_index`; статусы `needs_login`, `skipped` (P1).
- `Question`: `hint`, `options` (кнопки в макете); `default_answer` входит в `options`.
  Промпт `PARSE_TZ_SYSTEM` (Task 6) просит 2–3 варианта ответа.
- `OfferEntry`: `caption` — подпись строки, одна для таблицы, DOCX и сводки агента; `label`,
  `original`, `user_marks` — из спеки правок §8.
- `PositionReport.overrides` не выходит в API (по спеке правок его заменяют правки).

**Хранилище (Task 11)**
- `messages`: колонки `kind` и `data_json` вместо `meta_json`; сообщения `run`, `question`,
  `proposal`, `source_blocked` обновляются на месте (тот же `id`).
- `list_procurements` отдаёт поля `ProcurementSummary`: статус, `updated_at`, итоги и число
  необоснованных позиций последней версии.

**API и события (Task 12)**
- `POST /procurements`: поля `tz_text` (было `text`) и `message`; ответ — `Procurement`, а не `{id}`.
- `GET /procurements/{id}`: добавлены `status`, `agent_busy`, итоги; сообщения типизированы (§5.3).
- События: `message` (замена по `id`) заменяет `progress`, `question`, `error` из `events.py`.
  Ход поиска — сообщение `run`, которое обновляется; вопрос — сообщение `question`; ошибка —
  сообщение `error`. Добавлены `procurement` и `agent`. `report` — только `{version, cause}`,
  разница — в карточке `version`. `proposal` из спеки правок — тоже сообщение (`kind: "proposal"`).
- Отмена правок — `POST …/edits/cancel {edit_ids}` вместо `…/edits/{edit_id}/cancel`: «Отменить»
  в карточке версии отменяет все её правки одной версией.
- Ошибки 422 приводятся к `{"detail": str}`.
- `GET /settings`: добавлено `key_source`.

## 9. Проверка контракта

- **Бэкенд:** тест `backend/tests/test_api_contract.py` валидирует `docs/api-examples/report.json`
  моделью `Report`, а сообщения из `procurement.json` — моделью `Message`. Если тест падает после
  правки моделей — правится контракт и примеры, а не тест.
- **Фронтенд:** типы из §5 в `frontend/src/api/types.ts`; моки отдают файлы из
  `docs/api-examples/` (через MSW или простой слой-заглушку). Переключение на настоящий бэкенд —
  без правки компонентов.

## 10. Открыто

- Вид `Config` и `LocalSettings` — после макета страницы «Настройки».
- Протокол живого окна браузера (§3.6) — при реализации P1.
- Нужны ли доказательства к цене кроме ссылки (скриншот, копия страницы) — решается с видом
  отчёта; если да, добавится `Offer.evidence`.
- Потоковая печать ответа агента — P2.
