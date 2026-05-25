# NEM / WEM Live Dashboard — MVP (Round 1)

Real-time dashboard for the Australian electricity market — NEM (5 regions) and
WEM (WA Reference Trading Price) — built as the foundation of a BESS bidding
system / VPP operations console.

## What's in Round 1

- **Backend** (FastAPI + DuckDB)
  - Scraper polls `nemweb.com.au/Reports/Current/DispatchIS_Reports/` every 60s and
    upserts 5-min dispatch prices + FCAS for all 5 NEM regions.
  - WEM scraper polls AEMO WA `data.wa.aemo.com.au/.../referenceTradingPrice/current/`.
  - DuckDB at `webapp/backend/data/market.duckdb` (zero-config columnar store).
  - REST: `/api/snapshot`, `/api/history`, `/api/fcas/matrix`, `/api/health`.
  - SSE: `/api/stream` pushes a fresh snapshot every 30s.
- **Frontend** (Vite + React + TypeScript + Tailwind + Recharts)
  - 6 region tiles (NSW/QLD/VIC/SA/TAS + WA) with current price, 1h delta, demand.
  - 24h price chart for the selected region (toggle 6h / 24h / 3d / 7d).
  - FCAS 10-market × 5-region heatmap.
  - Live indicator backed by SSE.

## Run with Docker (recommended)

```bash
cd webapp
docker compose up --build
```

That builds two containers (FastAPI + Vite dev server) and wires them on a
shared network. DuckDB data persists in a named volume (`backend_data`).

- Frontend: <http://localhost:5173>
- API:      <http://localhost:8000/docs>

Edits to `backend/app/**.py` and `frontend/src/**` hot-reload inside the
containers (bind mounts + uvicorn `--reload` / Vite HMR).

To stop: `docker compose down`. To wipe the database too:
`docker compose down -v`.

## Run locally without Docker (alternative)

### Backend

```bash
cd webapp/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd webapp/frontend
npm install
npm run dev
```

On first start the backend backfills the last ~12 dispatch intervals (~1 hour of
NEM data) and the latest 1–2 days of WEM data, then keeps up live.

## Notes

- AEMO mandates **T+1 publication** of unit-level bids (BIDDAYOFFER /
  BIDPEROFFER) — strict real-time bids are not available. Round 2 will add the
  next-day bid stack ingestion.
- DuckDB file is local; safe to delete to re-backfill.
- All times stored as naive datetimes in NEM / WA timezone respectively
  (matches the source files); UI renders in browser locale.

## Round 2 backlog (proposed)

- Next-day BIDDAYOFFER + BIDPEROFFER ingestion → bid-stack visualisation
- Integrate the existing GNN+Transformer 5/30/60-min probabilistic forecasts
- BESS arbitrage signal: rolling 24h price spread, energy + FCAS co-opt revenue
- Interconnector congestion / counterprice flows
- WEM unit-level facility dispatch
- Price-spike alerting (push / webhook)
