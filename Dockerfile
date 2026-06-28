# ── Stage 1: Build React frontend ─────────────────────────────────────────────
FROM node:20-alpine AS frontend
WORKDIR /frontend

COPY webapp/frontend/package.json ./
RUN npm install

COPY webapp/frontend/ .
RUN npm run build
# → /frontend/dist


# ── Stage 2: Python backend + bundled frontend ─────────────────────────────────
FROM python:3.12-slim
WORKDIR /app

# libgomp1: OpenMP runtime required by the LightGBM wheel (forecast/ml.py).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY webapp/backend/requirements.txt .
RUN pip install --no-cache-dir --retries 5 --timeout 120 -r requirements.txt

COPY webapp/backend/app ./app
COPY --from=frontend /frontend/dist ./static

# Procfile: honcho runs the API (web) + scraper (scheduler) as TWO processes so
# a heavy scraper write can never freeze the API (they share the SQLite volume
# via WAL: API reads, scheduler writes).
COPY webapp/backend/Procfile ./Procfile

# SQLite database directory (mount a Railway volume here for persistence).
RUN mkdir -p /app/data

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# Two processes via honcho (see Procfile): web (uvicorn, RUN_SCHEDULER=0) +
# scheduler (app.run_scheduler). If either exits, honcho stops → Railway
# restarts the container (pairs with the scheduler watchdog for self-healing).
CMD ["honcho", "start"]
