UV ?= uv

.PHONY: setup dev test lint format check docker-up docker-down

setup:
	$(UV) sync --project backend --locked

dev:
	$(UV) run --project backend --locked uvicorn app.main:app --reload --reload-dir backend/app --host 127.0.0.1 --port 8000

test:
	$(UV) run --project backend --locked pytest backend/tests -q

lint:
	$(UV) run --project backend --locked ruff check backend
	$(UV) run --project backend --locked ruff format --check backend

format:
	$(UV) run --project backend --locked ruff check --fix backend
	$(UV) run --project backend --locked ruff format backend

check: lint test

docker-up:
	docker compose up --build --wait

docker-down:
	docker compose down
