# NEM / WEM Live Dashboard

Real-time intelligence, trading-simulation and project-finance platform for the
Australian electricity market — NEM (NSW1 / QLD1 / VIC1 / SA1 / TAS1) and WEM
(WA Reference Trading Price). Aggregates ~11 public data feeds (AEMO NEMWeb,
MMSDM registry, WEMDE, Open-Meteo, energy RSS) into a single bilingual (EN / 中文)
dashboard for traders, VPP aggregators, storage investors and analysts.

## Pages (7 top-level views)

1. **NEM** — multi-region live overview: prices, FCAS (10 markets), demand,
   interconnector flows, binding constraints, fuel mix, 90-day heatmap, K-line,
   14-day PASA adequacy (LOR1/2/3), CPT/APC state, weather, predispatch forecast.
2. **BESS** (NSW deep-dive) — battery operations + single-unit paper-trading sandbox.
3. **VPP** — virtual power plant aggregator console (bidding, settlement, compliance).
4. **VPP-Calc** — "should I join a VPP?" revenue simulator (C&I **and** residential).
5. **BESS-Calc** — 20-year battery project finance (NPV / IRR / DSCR, backtest, sensitivity).
6. **Stations** — per-DUID (generator/battery) X-ray.
7. **News** — energy news RSS + AEMO market notices.

## Architecture

- **Backend** — FastAPI + APScheduler + **SQLite (WAL)**.
  - ~11 scheduled scrapers poll AEMO/external sources (NEM DispatchIS & SCADA 60s;
    predispatch / bids / notices 5 min; rooftop PV 15 min; PASA 30 min; news 1 h;
    facility registry weekly) into ~15 tables. Last ~90 days backfilled on startup.
  - ~15 route modules under `app/routes/` (prices, grid, paper, vpp, vpp_calc,
    bess_calc, bids, pasa, price_forecast, mlf, station, stream, notices, news, weather).
  - In-memory TTL cache; `/api/health` reports per-source data staleness.
- **Frontend** — React 18 + TypeScript + Vite + Tailwind + Recharts + d3-geo.
  - Lazy-loaded views (code-split), SSE live updates, interactive maps, animated landing page.

## Run with Docker (local dev)

```bash
cd webapp
docker compose up --build
```

- Frontend: <http://localhost:5173> (Vite HMR)
- API + docs: <http://localhost:8001/docs>

SQLite persists in the named volume `backend_data`. Backend (`app/**.py`) and
frontend (`src/**`) hot-reload via bind mounts + uvicorn `--reload` / Vite HMR.
Stop: `docker compose down` (add `-v` to wipe the database).

## Run locally without Docker

```bash
# backend
cd webapp/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# frontend (separate shell)
cd webapp/frontend
npm install && npm run dev
```

## Production

Two-stage `Dockerfile.production` (node build → python runtime serving the Vite
`dist/` as static files from one container), deployed on Railway with the SQLite
DB on a mounted volume (`/app/data`). Healthcheck: `GET /api/snapshot`.

## Notes

- AEMO publishes unit-level bids next-day (BIDDAYOFFER / BIDPEROFFER); the bid-stack
  views reflect that cadence. Dispatch prices/SCADA are ~5 min real-time.
- **Forecasting**: `/api/forecast` (and the price-forecast widgets) serve AEMO's
  **official** predispatch (P5MIN / PREDISPATCH). The experimental GNN-Transformer
  in the repo root `/src/` is a **separate offline research pipeline** and is **not**
  wired into the live app.
- **Simulated data**: paper-trading, the VPP console fleet and competitor bids use
  seeded/simulated state for demonstration; treat figures there as illustrative.
- Times are stored as naive datetimes in NEM / WA local time (matching source files);
  the UI renders in browser locale. The SQLite file is safe to delete to re-backfill.

## Docs

See `docs/` — `PROJECT_OVERVIEW.md`, `PRODUCT_OVERVIEW.md`, `PRD.md` for the
full product, data-source and requirements detail.
