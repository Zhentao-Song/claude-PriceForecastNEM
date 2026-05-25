"""WEM (Western Australia) Reference Trading Price scraper.

Post-2023 WEMDE reform publishes daily JSON files at:
  https://data.wa.aemo.com.au/public/market-data/wemde/referenceTradingPrice/current/

File format:
  ReferenceTradingPrice_YYYY-MM-DD.json
  {
    "transactionId": "...",
    "data": {
      "tradingDay": "YYYY-MM-DD",
      "referenceTradingPrices": [
        {"tradingInterval": "2026-05-10T08:00:00+08:00",
         "referenceTradingPrice": 81.66, "isPublished": true},
        ...
      ]
    }
  }
"""
from __future__ import annotations

import logging
import re
from datetime import datetime

import httpx

from ..config import HTTP_TIMEOUT, USER_AGENT, WEMDE_REFTRADINGPRICE_DIR
from ..db import locked_conn

log = logging.getLogger("scraper.wem")


def _parse_iso(s: str) -> datetime | None:
    if not s:
        return None
    try:
        # fromisoformat handles "+08:00" tz offsets; we strip tz to store naive WA time.
        dt = datetime.fromisoformat(s)
        return dt.replace(tzinfo=None) if dt.tzinfo else dt
    except ValueError:
        return None


async def list_files(client: httpx.AsyncClient) -> list[str]:
    r = await client.get(WEMDE_REFTRADINGPRICE_DIR, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    hrefs = re.findall(r'href="([^"]+\.json)"', r.text, flags=re.IGNORECASE)
    return sorted({h.rsplit("/", 1)[-1] for h in hrefs})


async def fetch_json(client: httpx.AsyncClient, filename: str) -> dict:
    url = WEMDE_REFTRADINGPRICE_DIR + filename
    r = await client.get(url, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.json()


def parse_and_upsert(payload: dict) -> int:
    rows = (payload.get("data") or {}).get("referenceTradingPrices") or []
    insert: list[tuple] = []
    for row in rows:
        ts = _parse_iso(row.get("tradingInterval", ""))
        rtp = row.get("referenceTradingPrice")
        if ts is None or rtp is None:
            continue
        insert.append((ts, float(rtp), None))
    if not insert:
        return 0
    with locked_conn() as con:
        con.executemany(
            """
            INSERT INTO wem_price VALUES (?, ?, ?)
            ON CONFLICT(interval_start) DO UPDATE SET
                reference_trading_price = excluded.reference_trading_price
            """,
            insert,
        )
    return len(insert)


async def run_once() -> dict:
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        try:
            files = await list_files(client)
        except Exception as e:
            log.warning("WEM list failed: %s", e)
            return {"error": str(e)}
        if not files:
            return {"files": 0}
        # Pull the latest file (today's; current/ holds today only most days).
        todo = files[-2:]
        total = 0
        for fn in todo:
            try:
                payload = await fetch_json(client, fn)
                total += parse_and_upsert(payload)
            except Exception as e:
                log.warning("WEM file %s failed: %s", fn, e)
        return {"files": len(todo), "rows": total}
