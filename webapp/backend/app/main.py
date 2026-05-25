from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import scheduler
from .db import get_conn
from .routes import bess_calc, bids, grid, paper, prices, stream, vpp

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_conn()  # initialise schema
    scheduler.start()
    yield
    scheduler.stop()


app = FastAPI(title="NEM/WEM Live Dashboard", lifespan=lifespan)

# Vite dev server runs on 5173. Open CORS for local dev only.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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
app.include_router(bess_calc.router)


@app.get("/")
def root():
    return {"name": "NEM/WEM Live Dashboard API", "docs": "/docs"}
