"""AEMO Market Notices scraper.

NEMWeb /Reports/Current/Market_Notice/ holds one plain-text file per notice:

    NEMITWEB1_MKTNOTICE_YYYYMMDD.R<notice_id>

Fixed-layout body, e.g.:

    Creation Date :     10/06/2026     15:17:27
    Notice ID               :         144236
    Notice Type ID          :         INTER-REGIONAL TRANSFER
    Notice Type Description :         Inter-Regional Transfer limit variation
    External Reference      :         ... - VIC region - 10/06/2026
    Reason :
    <free text>

These are the LOR1/2/3 reserve warnings, price-cap (CPT) events, market
interventions, constraint reclassifications etc. that every professional
NEM tool surfaces as a live event feed.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime

import httpx

from ..config import HTTP_TIMEOUT, NEMWEB_BASE, USER_AGENT
from ..db import write_conn
from .nem import get_last_file, set_state

log = logging.getLogger("scraper.market_notices")

NOTICE_DIR = f"{NEMWEB_BASE}/Reports/Current/Market_Notice/"
FILENAME_RE = re.compile(r"NEMITWEB1_MKTNOTICE_(\d{8})\.R(\d+)$", re.IGNORECASE)

# Keep the table bounded — old notices age out (NEMWeb itself only holds
# a rolling window; 500 ≈ several weeks of traffic).
KEEP_NOTICES = 500


def _field(text: str, label: str) -> str | None:
    m = re.search(rf"^{re.escape(label)}\s*:\s*(.+?)\s*$", text, re.MULTILINE)
    return m.group(1).strip() if m else None


def parse_notice(text: str) -> dict | None:
    nid = _field(text, "Notice ID")
    if not nid or not nid.isdigit():
        return None
    # "Creation Date :     10/06/2026     15:17:27"
    created_raw = _field(text, "Creation Date") or ""
    created_iso = None
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})\s+(\d{2}:\d{2}:\d{2})", created_raw)
    if m:
        created_iso = f"{m.group(3)}-{m.group(2)}-{m.group(1)} {m.group(4)}"

    reason = ""
    rm = re.search(r"^Reason\s*:\s*$(.*)", text, re.MULTILINE | re.DOTALL)
    if rm:
        reason = rm.group(1).strip()
        # Strip the boilerplate separator lines.
        reason = re.sub(r"^-{10,}\s*$", "", reason, flags=re.MULTILINE).strip()

    return {
        "notice_id": int(nid),
        "notice_type": _field(text, "Notice Type ID") or "GENERAL",
        "type_description": _field(text, "Notice Type Description"),
        "creation_date": created_iso,
        "external_ref": _field(text, "External Reference"),
        "reason": reason[:4000],
    }


async def list_remote_files(client: httpx.AsyncClient) -> list[str]:
    r = await client.get(NOTICE_DIR, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    hrefs = re.findall(r'href="([^"]+)"', r.text, flags=re.IGNORECASE)
    files = [h.rsplit("/", 1)[-1] for h in hrefs if FILENAME_RE.search(h)]
    # Filename sorts correctly: fixed-width date, then R<id> with a
    # monotonically increasing id of stable width.
    return sorted(set(files))


def upsert_notices(parsed: list[dict]) -> int:
    if not parsed:
        return 0
    with write_conn() as con:
        con.executemany(
            """
            INSERT INTO nem_market_notice
                (notice_id, notice_type, type_description, creation_date,
                 external_ref, reason)
            VALUES (:notice_id, :notice_type, :type_description,
                    :creation_date, :external_ref, :reason)
            ON CONFLICT(notice_id) DO UPDATE SET
                notice_type = excluded.notice_type,
                type_description = excluded.type_description,
                creation_date = excluded.creation_date,
                external_ref = excluded.external_ref,
                reason = excluded.reason
            """,
            parsed,
        )
        con.execute(
            """
            DELETE FROM nem_market_notice WHERE notice_id NOT IN (
                SELECT notice_id FROM nem_market_notice
                ORDER BY notice_id DESC LIMIT ?
            )
            """,
            (KEEP_NOTICES,),
        )
    return len(parsed)


async def run_once(backfill_n: int = 60) -> dict:
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        try:
            files = await list_remote_files(client)
        except Exception as e:
            set_state("nem_market_notices", None, error=f"list failed: {e}")
            log.exception("market notices list failed")
            return {"error": str(e)}
        if not files:
            return {"new_files": 0}

        last = get_last_file("nem_market_notices")
        todo = files[-backfill_n:] if last is None else [f for f in files if f > last]
        # Defensive cap — never pull thousands at once if state was wiped.
        todo = todo[-200:]

        parsed: list[dict] = []
        last_done = last
        for fn in todo:
            try:
                r = await client.get(NOTICE_DIR + fn, timeout=HTTP_TIMEOUT)
                r.raise_for_status()
                p = parse_notice(r.text)
                if p:
                    parsed.append(p)
                last_done = fn
            except Exception as e:
                log.warning("market notice %s failed: %s", fn, e)
                set_state("nem_market_notices", last_done, error=str(e))
                break

        n = upsert_notices(parsed)
        set_state("nem_market_notices", last_done, error=None)
        if n:
            log.info("market notices: %d new", n)
        return {"new_files": len(todo), "rows": n}
