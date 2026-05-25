"""AEMO BIDDAYOFFER / BIDPEROFFER scraper.

NER 3.8.6 says a generator submits its 10-band price stack by 12:30 the day
before each trading day. Those prices are then **locked** for the whole day;
the per-interval MW availability at each band can be rebid right up to gate
closure (T-5min, NER 3.8.20). AEMO publishes three relevant feeds on NEMWeb:

- **Next_Day_Offer_Energy / Next_Day_Offer_FCAS** — Published ~12:30 the day
  before the trading day. Each file is a one-shot snapshot of the *initial*
  BIDDAYOFFER_D + BIDPEROFFER_D for every DUID, every market, for the next
  trading day. This is the day-ahead view: the bid stack as the day starts.
- **Bidmove_Summary** — Live during the trading day. Captures rebids as they
  happen (BIDPEROFFER changes), so the database can show the *current*
  binding bid for any interval. Smaller / faster than the full daily dump.
- **Bidmove_Complete** — Published once D+1 with the full daily history of
  every rebid + the final clearing-time bid stack. Useful for historical
  reconstruction but not for live visibility.

We poll Next_Day_Offer_* slowly (one file per day, no point checking more
than hourly) and Bidmove_Summary on the NEM tick cadence (so the live bid
stack reflects rebids within ~1 minute of submission).

The two tables (`nem_bidday_offer`, `nem_bidper_offer`) are designed to be
queried together: BIDDAYOFFER carries the 10 fixed prices, BIDPEROFFER tells
you how much MW each band offers at each interval. Joining them by
`(duid, bidtype, trading_date(interval_datetime))` reconstructs the bid
stack the market saw at any point in time.
"""
from __future__ import annotations

import asyncio
import csv
import io
import logging
import re
import zipfile
from datetime import datetime, timedelta
from typing import Iterable

import httpx

# Batch size for executemany. SPARSE day-ahead files routinely produce
# hundreds of thousands of rows; one giant transaction blocks the SQLite
# write lock for minutes and starves the API. Chunking gives reads a chance
# to slip in between batches.
UPSERT_BATCH = 5000

from ..config import (
    HTTP_TIMEOUT,
    NEM_BIDMOVE_COMPLETE_DIR,
    NEM_NEXT_DAY_OFFER_ENERGY_DIR,
    NEM_NEXT_DAY_OFFER_FCAS_DIR,
    USER_AGENT,
)
from ..db import locked_conn
from .mms import parse_mms_csv
from .nem import get_last_file, set_state

log = logging.getLogger("scraper.bids")

# Filename patterns verified against live NEMWEB May 2026. Timestamp section
# is 8–14 digits (YYYYMMDD for daily files, longer for occasional reruns).
RE_NEXT_DAY_ENERGY  = re.compile(r"PUBLIC_NEXT_DAY_OFFER_ENERGY_SPARSE_(\d{8,14})_\d+\.zip", re.I)
RE_NEXT_DAY_FCAS    = re.compile(r"PUBLIC_NEXT_DAY_OFFER_FCAS_SPARSE_(\d{8,14})_\d+\.zip",   re.I)
RE_BIDMOVE_COMPLETE = re.compile(r"PUBLIC_BIDMOVE_COMPLETE_(\d{8,14})_\d+\.zip",             re.I)


# ---- Generic helpers (mirror predispatch.py) -----------------------------

def _parse_dt(s: str) -> datetime | None:
    s = (s or "").strip().strip('"')
    if not s:
        return None
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _to_float(s: str) -> float | None:
    s = (s or "").strip().strip('"')
    if s in ("", "NULL"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _to_int(s: str) -> int | None:
    v = _to_float(s)
    return int(v) if v is not None else None


def _norm_bidtype(s: str) -> str:
    """AEMO uses 'ENERGY' plus FCAS keys like 'RAISEREG', 'RAISE6SEC'... We
    keep the raw string but uppercase it so downstream code can compare
    directly with our paper-trading `Market` enum (which uses the same
    spelling)."""
    return (s or "").strip().strip('"').upper()


def _direction_from_bidtype(bidtype: str) -> str | None:
    # FCAS bids carry direction in the name (RAISE/LOWER); ENERGY does not —
    # the same DUID can submit both GEN and LOAD bids and they appear with
    # DIRECTION='GEN' or 'LOAD' in the CSV.
    if bidtype.startswith("RAISE"):
        return "GEN"
    if bidtype.startswith("LOWER"):
        return "LOAD"
    return None  # ENERGY: read DIRECTION from the row


async def _list_dir(client: httpx.AsyncClient, url: str, regex: re.Pattern) -> list[str]:
    r = await client.get(url, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    hrefs = re.findall(r'href="([^"]+\.zip)"', r.text, flags=re.IGNORECASE)
    return sorted({h.rsplit("/", 1)[-1] for h in hrefs if regex.search(h)})


async def _fetch_zip(client: httpx.AsyncClient, url: str) -> bytes:
    r = await client.get(url, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.content


def _extract_csv(zip_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        name = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
        if not name:
            raise RuntimeError("No CSV in zip")
        with zf.open(name) as f:
            return f.read().decode("utf-8", errors="replace")


# AEMO uses several spellings across the years and across feeds. Verified
# against live NEMWEB May 2026:
#   Bidmove_Complete (D+1 full snapshot) → BID_BIDDAYOFFER_D / BID_BIDPEROFFER_D
#   Next_Day_Offer_*_SPARSE (day-ahead)  → BIDS_BIDDAYOFFER / BIDS_BIDOFFERPERIOD_SPARSE
# We accept both. The SPARSE per-interval table has a slightly different
# field layout (it's a delta) but the column names we read (DUID, BIDTYPE,
# INTERVAL_DATETIME, BANDAVAIL1..10, MAXAVAIL, etc.) are the same.
_BIDDAY_TABLE_NAMES = {
    "BID_BIDDAYOFFER_D",            # Bidmove_Complete
    "BIDS_BIDDAYOFFER",             # Next_Day_Offer_*_SPARSE
    "BIDS_BIDDAYOFFER_D",
    "BIDDAYOFFER_D", "OFFER_BIDDAYOFFER",
}
_BIDPER_TABLE_NAMES = {
    "BID_BIDPEROFFER_D",            # Bidmove_Complete
    "BIDS_BIDOFFERPERIOD_SPARSE",   # Next_Day_Offer_*_SPARSE
    "BIDS_BIDPEROFFER_D",
    "BIDPEROFFER_D", "OFFER_BIDPEROFFER",
}


def _stream_extract_tables(
    zip_bytes: bytes,
    *,
    want_bidday: bool = True,
    want_bidper: bool = True,
) -> tuple[list[dict], list[dict]]:
    """Streaming MMS parser that materialises only the tables we ask for.

    SPARSE day-ahead files routinely decompress to 1 GB+ of CSV. Loading
    that all into a single string and then walking it via parse_mms_csv
    pegs one CPU + ~1.5 GB of RAM for many minutes. Here we:
      1. open the zip member as a stream (no full decode upfront)
      2. wrap it in TextIOWrapper so csv.reader can iterate line-by-line
      3. only build dicts for the tables we actually want

    Cuts a 5-minute, 1 GB job to ~30 s and ~50 MB RAM in practice.
    """
    bidday_rows: list[dict] = []
    bidper_rows: list[dict] = []
    bidday_schema: list[str] | None = None
    bidper_schema: list[str] | None = None

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        name = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
        if not name:
            return bidday_rows, bidper_rows
        with zf.open(name) as fh:
            text = io.TextIOWrapper(fh, encoding="utf-8", errors="replace",
                                    newline="")
            reader = csv.reader(text)
            for row in reader:
                if not row:
                    continue
                rtype = row[0]
                if rtype == "I" and len(row) >= 5:
                    key = f"{row[1]}_{row[2]}"
                    if want_bidday and key in _BIDDAY_TABLE_NAMES:
                        bidday_schema = row[4:]
                    elif want_bidper and key in _BIDPER_TABLE_NAMES:
                        bidper_schema = row[4:]
                    # Other I-rows just rebind nothing — we skip those D rows.
                elif rtype == "D" and len(row) >= 5:
                    key = f"{row[1]}_{row[2]}"
                    schema = None
                    sink = None
                    if bidday_schema is not None and key in _BIDDAY_TABLE_NAMES:
                        schema, sink = bidday_schema, bidday_rows
                    elif bidper_schema is not None and key in _BIDPER_TABLE_NAMES:
                        schema, sink = bidper_schema, bidper_rows
                    if schema is None:
                        continue
                    values = row[4:]
                    if len(values) < len(schema):
                        values = values + [""] * (len(schema) - len(values))
                    sink.append(dict(zip(schema, values)))
    return bidday_rows, bidper_rows


# ---- BIDDAYOFFER_D parser + upsert --------------------------------------

# AEMO MMS column names. Captured from the BIDDAYOFFER_D schema we care
# about; columns we don't store (RUN_NO, OFFER_DATE, AUTHORISED_DATE,
# etc.) are simply ignored.
def _parse_bidday_rows(rows: Iterable[dict[str, str]]) -> list[tuple]:
    out: list[tuple] = []
    for r in rows:
        sd = _parse_dt(r.get("SETTLEMENTDATE", "") or r.get("EFFECTIVEDATE", ""))
        duid = (r.get("DUID", "") or "").strip().strip('"')
        bidtype = _norm_bidtype(r.get("BIDTYPE", ""))
        if not sd or not duid or not bidtype:
            continue
        direction = _direction_from_bidtype(bidtype) or (
            (r.get("DIRECTION", "") or "").strip().strip('"') or None
        )
        out.append((
            sd, duid, bidtype, direction,
            (r.get("ENTRYTYPE", "") or "").strip().strip('"') or None,
            _to_float(r.get("PRICEBAND1", "")), _to_float(r.get("PRICEBAND2", "")),
            _to_float(r.get("PRICEBAND3", "")), _to_float(r.get("PRICEBAND4", "")),
            _to_float(r.get("PRICEBAND5", "")), _to_float(r.get("PRICEBAND6", "")),
            _to_float(r.get("PRICEBAND7", "")), _to_float(r.get("PRICEBAND8", "")),
            _to_float(r.get("PRICEBAND9", "")), _to_float(r.get("PRICEBAND10", "")),
            _to_float(r.get("DAILYENERGYCONSTRAINT", "")),
            _to_float(r.get("T1", "")), _to_float(r.get("T2", "")),
            _to_float(r.get("T3", "")), _to_float(r.get("T4", "")),
            _to_float(r.get("MINIMUMLOAD", "")),
            _parse_dt(r.get("LASTCHANGED", "") or r.get("OFFERDATE", "")) or datetime.utcnow(),
        ))
    return out


_BIDDAY_SQL = """
    INSERT INTO nem_bidday_offer
        (settlementdate, duid, bidtype, direction, entrytype,
         priceband1, priceband2, priceband3, priceband4, priceband5,
         priceband6, priceband7, priceband8, priceband9, priceband10,
         daily_energy_constraint, t1, t2, t3, t4, minimumload,
         submitted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(settlementdate, duid, bidtype) DO UPDATE SET
        direction = excluded.direction,
        entrytype = excluded.entrytype,
        priceband1 = excluded.priceband1, priceband2 = excluded.priceband2,
        priceband3 = excluded.priceband3, priceband4 = excluded.priceband4,
        priceband5 = excluded.priceband5, priceband6 = excluded.priceband6,
        priceband7 = excluded.priceband7, priceband8 = excluded.priceband8,
        priceband9 = excluded.priceband9, priceband10 = excluded.priceband10,
        daily_energy_constraint = excluded.daily_energy_constraint,
        t1 = excluded.t1, t2 = excluded.t2, t3 = excluded.t3, t4 = excluded.t4,
        minimumload = excluded.minimumload,
        submitted_at = excluded.submitted_at
    WHERE excluded.submitted_at >= nem_bidday_offer.submitted_at
"""


def _upsert_bidday(payload: list[tuple]) -> int:
    if not payload:
        return 0
    # Chunk so we release the SQLite write lock between batches — keeps
    # /api/* responsive even when ingesting a 100k-row SPARSE file.
    for i in range(0, len(payload), UPSERT_BATCH):
        chunk = payload[i:i + UPSERT_BATCH]
        with locked_conn() as con:
            con.executemany(_BIDDAY_SQL, chunk)
    return len(payload)


# ---- BIDPEROFFER_D parser + upsert --------------------------------------

def _parse_bidper_rows(
    rows: Iterable[dict[str, str]],
    *,
    default_version: int = 1,
) -> list[tuple]:
    """Per-interval availability rows. The MMS table publishes one row per
    (DUID, BIDTYPE, PERIODID) where PERIODID is 1..48 (30-min historical) or
    a similar enum; we derive INTERVAL_DATETIME directly from the row when
    present (it's there in modern feeds since 5MS).

    AEMO sometimes leaves INTERVAL_DATETIME blank in older Bidmove files; in
    that case we compute it as SETTLEMENTDATE + PERIODID * 30min (legacy
    30-min trading interval convention). 5MS dispatches at 5min cadence,
    but BIDPEROFFER continues to publish at 30min granularity — the same
    availability applies to all six 5-min intervals inside that half hour."""
    out: list[tuple] = []
    for r in rows:
        idt = _parse_dt(r.get("INTERVAL_DATETIME", ""))
        sd = _parse_dt(r.get("SETTLEMENTDATE", "") or r.get("EFFECTIVEDATE", ""))
        periodid = _to_int(r.get("PERIODID", ""))
        if idt is None and sd is not None and periodid is not None:
            # PERIODID 1 = 00:30 (end-of-interval convention).
            idt = sd + timedelta(minutes=30 * periodid)
        if idt is None:
            continue
        duid = (r.get("DUID", "") or "").strip().strip('"')
        bidtype = _norm_bidtype(r.get("BIDTYPE", ""))
        if not duid or not bidtype:
            continue
        submitted_at = (
            _parse_dt(r.get("LASTCHANGED", "")
                      or r.get("OFFERDATE", "")
                      or r.get("AUTHORISEDDATE", ""))
            or datetime.utcnow()
        )
        out.append((
            idt, duid, bidtype,
            _to_float(r.get("BANDAVAIL1", "")), _to_float(r.get("BANDAVAIL2", "")),
            _to_float(r.get("BANDAVAIL3", "")), _to_float(r.get("BANDAVAIL4", "")),
            _to_float(r.get("BANDAVAIL5", "")), _to_float(r.get("BANDAVAIL6", "")),
            _to_float(r.get("BANDAVAIL7", "")), _to_float(r.get("BANDAVAIL8", "")),
            _to_float(r.get("BANDAVAIL9", "")), _to_float(r.get("BANDAVAIL10", "")),
            _to_float(r.get("MAXAVAIL", "")),
            _to_float(r.get("FIXEDLOAD", "")),
            _to_float(r.get("ROCUP", "") or r.get("RAMPUPRATE", "")),
            _to_float(r.get("ROCDOWN", "") or r.get("RAMPDOWNRATE", "")),
            submitted_at,
            (r.get("REBIDREASON", "") or r.get("REBID_REASON", "") or "").strip().strip('"') or None,
            (r.get("REBIDEXPLANATION", "") or r.get("REBID_EXPLANATION", "") or "").strip().strip('"') or None,
            default_version,
        ))
    return out


_BIDPER_SQL = """
    INSERT OR IGNORE INTO nem_bidper_offer
        (interval_datetime, duid, bidtype,
         bandavail1, bandavail2, bandavail3, bandavail4, bandavail5,
         bandavail6, bandavail7, bandavail8, bandavail9, bandavail10,
         maxavail, fixedload, rampuprate, rampdownrate,
         submitted_at, rebid_reason, rebid_explanation, version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
"""


def _upsert_bidper(payload: list[tuple]) -> int:
    if not payload:
        return 0
    for i in range(0, len(payload), UPSERT_BATCH):
        chunk = payload[i:i + UPSERT_BATCH]
        with locked_conn() as con:
            con.executemany(_BIDPER_SQL, chunk)
    return len(payload)


# ---- File processors ----------------------------------------------------

def _parse_and_upsert(zip_bytes: bytes, *, default_version: int,
                      ingest_per: bool = True) -> tuple[int, int]:
    """Stream-decode the zip + filter + upsert in one worker thread call."""
    import time
    t0 = time.monotonic()
    bidday_rows, bidper_rows = _stream_extract_tables(
        zip_bytes, want_bidday=True, want_bidper=ingest_per,
    )
    log.info("bids parse: %d bidday + %d bidper rows in %.1fs (zip %d KB)",
             len(bidday_rows), len(bidper_rows), time.monotonic()-t0,
             len(zip_bytes) // 1024)
    t1 = time.monotonic()
    n_day = _upsert_bidday(_parse_bidday_rows(bidday_rows))
    log.info("bids parse: upsert_bidday %d rows in %.1fs", n_day, time.monotonic()-t1)
    n_per = 0
    if ingest_per and bidper_rows:
        t2 = time.monotonic()
        n_per = _upsert_bidper(_parse_bidper_rows(bidper_rows, default_version=default_version))
        log.info("bids parse: upsert_bidper %d rows in %.1fs", n_per, time.monotonic()-t2)
    return n_day, n_per


async def _process_one(client: httpx.AsyncClient, base_url: str, fn: str,
                       *, default_version: int, ingest_per: bool) -> tuple[int, int]:
    zip_bytes = await _fetch_zip(client, base_url + fn)
    # Decompress + parse + upsert all happen in a worker thread, so the
    # event loop can still serve /api/* and tick other scrapers concurrently.
    def work():
        return _parse_and_upsert(zip_bytes, default_version=default_version,
                                 ingest_per=ingest_per)
    return await asyncio.to_thread(work)


# ---- Pruning ------------------------------------------------------------

def _prune_stale() -> int:
    """Keep 14 days of bid history. Past that, BIDDAYOFFER prices stop
    being useful (you already have the cleared price + outcomes), and the
    table grows fast — every DUID × 11 markets × 48 intervals per day."""
    cutoff = (datetime.utcnow() + timedelta(hours=10) - timedelta(days=14)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    with locked_conn() as con:
        c1 = con.execute(
            "DELETE FROM nem_bidper_offer WHERE interval_datetime < ?", (cutoff,)
        )
        c2 = con.execute(
            "DELETE FROM nem_bidday_offer WHERE settlementdate < ?", (cutoff,)
        )
    return (c1.rowcount or 0) + (c2.rowcount or 0)


# ---- Public entry point -------------------------------------------------

async def run_once() -> dict:
    """Poll all four bid feeds (energy + FCAS day-ahead, plus live + complete
    bidmove). Cheap when no new files have landed since the last tick."""
    headers = {"User-Agent": USER_AGENT}
    result = {
        "next_day_energy": {}, "next_day_fcas": {}, "bidmove_complete": {},
    }
    # Bidmove_Complete carries the *full* rebid history for the trading day
    # (one file per day, D+1). It includes both the day-ahead BIDDAYOFFER
    # rows and every subsequent BIDPEROFFER version with reason codes —
    # which means it doubles as our rebid history source. Each row's
    # `LASTCHANGED` distinguishes versions; we tag them version=2+ for any
    # bid where LASTCHANGED > the trading day's 04:00 start (= an in-day
    # rebid, not the day-ahead submission).
    # Per feed: (state_key, url, regex, result_key, default_version,
    #            max_files_per_tick, ingest_bidper)
    # Day-ahead SPARSE files are huge (~40MB compressed, ~200MB CSV) and
    # carry BIDPEROFFER rows for every DUID × 48 intervals. Bidmove_Complete
    # the next day re-publishes the SAME data plus rebid history, so we save
    # ourselves the work and only take the small BIDDAYOFFER table here.
    feeds = [
        ("nem_next_day_offer_energy", NEM_NEXT_DAY_OFFER_ENERGY_DIR,
         RE_NEXT_DAY_ENERGY, "next_day_energy", 1, 1, False),
        ("nem_next_day_offer_fcas",   NEM_NEXT_DAY_OFFER_FCAS_DIR,
         RE_NEXT_DAY_FCAS,   "next_day_fcas",   1, 1, False),
        ("nem_bidmove_complete",      NEM_BIDMOVE_COMPLETE_DIR,
         RE_BIDMOVE_COMPLETE,"bidmove_complete",2, 1, True),
    ]
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        for source_id, base_url, regex, result_key, default_version, max_per_tick, ingest_per in feeds:
            try:
                files = await _list_dir(client, base_url, regex)
                if not files:
                    result[result_key] = {"new_files": 0}
                    continue
                last = get_last_file(source_id)
                todo = [f for f in files if f > last] if last else files[-max_per_tick:]
                # Cap per tick — each file can be many MB and parsing all
                # historical rebids in one go would stall the scheduler.
                todo = todo[-max_per_tick:]
                n_day_total = n_per_total = 0
                last_done = last
                for fn in todo:
                    try:
                        n_day, n_per = await _process_one(
                            client, base_url, fn,
                            default_version=default_version,
                            ingest_per=ingest_per,
                        )
                        n_day_total += n_day; n_per_total += n_per
                        last_done = fn
                    except Exception as e:
                        log.warning("bids %s file %s failed: %s", source_id, fn, e)
                        set_state(source_id, last_done, error=str(e))
                        break
                set_state(source_id, last_done, error=None)
                result[result_key] = {
                    "new_files": len(todo),
                    "rows_bidday": n_day_total, "rows_bidper": n_per_total,
                }
            except Exception as e:
                log.exception("bids %s list failed", source_id)
                set_state(source_id, None, error=str(e))
                result[result_key] = {"error": str(e)}

    try:
        result["pruned"] = _prune_stale()
    except Exception:
        log.exception("bid prune failed")

    return result
