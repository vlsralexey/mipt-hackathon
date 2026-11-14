FROM node:24-slim AS frontend

WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
COPY docs/api-examples/ /docs/api-examples/
RUN npm run build && rm -f dist/mockServiceWorker.js

FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /usr/local/bin/uv

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH" \
    DATA_DIR=/data \
    FRONTEND_DIR=/app/frontend \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

WORKDIR /app

COPY backend/pyproject.toml backend/uv.lock ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 \
    && uv sync --frozen --no-dev --no-install-project \
    && .venv/bin/playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright \
    && rm -rf /var/lib/apt/lists/*


COPY backend/app ./app
COPY backend/config ./config
COPY --from=frontend /frontend/dist ./frontend
RUN uv sync --frozen --no-dev --no-editable \
    && groupadd --gid 10001 nmck \
    && useradd --uid 10001 --gid nmck --no-create-home nmck \
    && mkdir /data \
    && chown nmck:nmck /data

USER nmck

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
