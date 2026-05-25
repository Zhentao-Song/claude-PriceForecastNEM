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

COPY webapp/backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt aiofiles

COPY webapp/backend/app ./app
COPY --from=frontend /frontend/dist ./static

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# Railway injects $PORT; fall back to 8000 for local docker run
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
