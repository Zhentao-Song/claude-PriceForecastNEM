from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import scheduler
from .db import get_conn
from .routes import (
    bess_calc, bids, grid, mlf, news, notices, paper, pasa, price_forecast,
    prices, station, stream, vpp, vpp_calc, weather,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_conn()  # initialise schema
    # The scrapers (heavy SQLite writers) now run in a SEPARATE process
    # (app.run_scheduler), so a write stall can never freeze this API process.
    # Set RUN_SCHEDULER=0 in the API process; default "1" keeps the legacy
    # single-process behaviour for anyone running main.py standalone.
    run_scheduler = os.getenv("RUN_SCHEDULER", "1").strip().lower() not in ("0", "false", "no")
    if run_scheduler:
        scheduler.start()
    yield
    if run_scheduler:
        scheduler.stop()


app = FastAPI(title="NEM/WEM Live Dashboard", lifespan=lifespan)

# CORS: allow local dev + any extra origins set via env var (e.g. a separate
# Railway frontend service).  In the normal single-service production deploy
# the frontend is served from the same origin, so CORS is not exercised.
_cors_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
_extra_origins = os.getenv("ALLOWED_ORIGINS", "")
if _extra_origins:
    _cors_origins.extend(o.strip() for o in _extra_origins.split(",") if o.strip())

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(prices.router)
app.include_router(stream.router)
app.include_router(grid.router)
app.include_router(paper.router)
app.include_router(bids.router)
app.include_router(vpp.router)
app.include_router(vpp_calc.router)
app.include_router(bess_calc.router)
app.include_router(price_forecast.router)
app.include_router(mlf.router)
app.include_router(pasa.router)
app.include_router(weather.router)
app.include_router(notices.router)
app.include_router(news.router)
app.include_router(station.router)


# ── Serve bundled React frontend (production only) ────────────────────────────
# In the Docker production build the Vite dist is copied to /app/static.
# In local dev this directory doesn't exist, so we fall back to a plain JSON root.
_static_dir = Path(__file__).resolve().parent.parent / "static"
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="frontend")
else:
    @app.get("/")
    def root():
        return {"name": "NEM/WEM Live Dashboard API", "docs": "/docs"}
