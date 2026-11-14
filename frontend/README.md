# Фронтенд

React, Vite, TypeScript. План и состояние этапов — [docs/frontend-roadmap.md](../docs/frontend-roadmap.md),
контракт с бэкендом — [docs/api.md](../docs/api.md).

```bash
make frontend-setup   # npm ci
make frontend-dev     # http://localhost:5173
make frontend-check   # oxlint, tsc, vitest
```

Пока бэкенд не готов, в `npm run dev` на запросы `/api` отвечают моки (MSW) с данными из
`docs/api-examples/`. Настоящий бэкенд на `localhost:8000`: `VITE_MOCKS=off npm run dev`.
