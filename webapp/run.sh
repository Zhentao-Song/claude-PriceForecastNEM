#!/usr/bin/env bash
# Convenience launcher: runs backend + frontend together.
# Use Ctrl-C to stop both.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Backend
(
  cd backend
  if [ ! -d .venv ]; then
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt
  else
    source .venv/bin/activate
  fi
  uvicorn app.main:app --reload --port 8000
) &
BACK_PID=$!

# Frontend
(
  cd frontend
  if [ ! -d node_modules ]; then npm install; fi
  npm run dev
) &
FRONT_PID=$!

trap "kill $BACK_PID $FRONT_PID 2>/dev/null; exit" INT TERM
wait
