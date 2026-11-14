# Фронтенд

React, Vite, TypeScript. План и состояние этапов — [docs/frontend-roadmap.md](../docs/frontend-roadmap.md),
контракт с бэкендом — [docs/api.md](../docs/api.md).

```bash
make frontend-setup   # npm ci
make frontend-dev     # http://localhost:5173
make frontend-check   # oxlint, tsc, vitest, production-сборка
```

Нужны Node.js 24 и npm. По умолчанию интерфейс использует настоящий API:
запустите `make dev` в другом терминале. Vite проксирует `/api`, включая SSE,
на `localhost:8000`. На странице «Настройки» можно сохранить ключ OpenRouter и модель.

Демонстрация без бэкенда с данными из `docs/api-examples/`:
`VITE_MOCKS=on npm run dev --prefix frontend` из корня репозитория.
При обычном запуске старый MSW снимается с регистрации.

Общий запуск без Vite: `docker compose up --build --wait` из корня репозитория,
затем откройте <http://localhost:8000>. Docker собирает фронтенд, FastAPI раздаёт
статику и обслуживает API на одном порте. Подробности: [README](../README.md).
