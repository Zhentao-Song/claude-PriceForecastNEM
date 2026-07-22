"""DUID-level historical BESS dispatch and FCAS enablement backfill.

AEMO's monthly ``DISPATCHLOAD`` archive contains one row per dispatchable
unit per five-minute interval.  It is the public D+1 source for the energy
target and the MW enabled by NEMDE in each FCAS service.  The source files
are large (roughly 1 GB of CSV per month), so this importer streams each ZIP
and retains only registered grid-scale batteries in the requested region.

The resulting table supports two distinct benchmark calculations:

* energy: public dispatch/SCADA proxy valued at the regional RRP; and
* FCAS: actual enabled MW valued using AEMO's MWE x clearing price / 12
  settlement formula.

It does not claim to reproduce metered energy settlement, contracts, FPP,
rebates, or participant fees.
"""
from __future__ import annotations

import csv
from datetime import date
import logging
from pathlib import Path
import tempfile
from typing import Iterable
import zipfile

import httpx

from ..config import USER_AGENT
from ..db import locked_conn, write_conn
from .nem import _parse_dt


log = logging.getLogger("scraper.bess_actuals")

MMSDM_BASE_URL = "https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM"
MIN_GRID_BESS_MW = 20.0

FCAS_FIELDS = (
    "RAISE6SEC", "RAISE60SEC", "RAISE5MIN", "RAISEREG", "RAISE1SEC",
    "LOWER6SEC", "LOWER60SEC", "LOWER5MIN", "LOWERREG", "LOWER1SEC",
)


def _archive_url(year: int, month: int) -> str:
    ym = f"{year}{month:02d}"
    filename = f"PUBLIC_ARCHIVE%23DISPATCHLOAD%23FILE01%23{ym}010000.zip"
    return (
        f"{MMSDM_BASE_URL}/{year}/MMSDM_{year}_{month:02d}/"
        f"MMSDM_Historical_Data_SQLLoader/DATA/{filename}"
    )


def _float(value: str | None) -> float | None:
    if value is None:
        return None
    value = value.strip().strip('"')
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def candidate_batteries(region: str = "SA1") -> dict[str, dict]:
    """Return active grid-scale BESS DUID metadata from AEMO registration."""
    with locked_conn() as con:
        rows = con.execute(
            """
            SELECT duid, station, capacity_mw, tlf
            FROM nem_facility_registry
            WHERE region = ? AND fuel = 'battery'
              AND UPPER(COALESCE(dispatch_type, '')) = 'BIDIRECTIONAL'
              AND COALESCE(capacity_mw, 0) >= ?
            ORDER BY capacity_mw DESC
            """,
            (region.upper(), MIN_GRID_BESS_MW),
        ).fetchall()
    return {
        str(row[0]): {
            "duid": str(row[0]),
            "station": row[1] or row[0],
            "capacity_mw": float(row[2]),
            "mlf": float(row[3]) if row[3] is not None else 1.0,
            "region": region.upper(),
        }
        for row in rows
    }


def _upsert_rows(rows: Iterable[tuple]) -> int:
    payload = list(rows)
    if not payload:
        return 0
    with write_conn() as con:
        con.executemany(
            """
            INSERT INTO nem_bess_dispatch VALUES (
                ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            )
            ON CONFLICT(settlementdate, duid) DO UPDATE SET
                initial_mw = excluded.initial_mw,
                totalcleared_mw = excluded.totalcleared_mw,
                raise6sec_mw = excluded.raise6sec_mw,
                raise60sec_mw = excluded.raise60sec_mw,
                raise5min_mw = excluded.raise5min_mw,
                raisereg_mw = excluded.raisereg_mw,
                raise1sec_mw = excluded.raise1sec_mw,
                lower6sec_mw = excluded.lower6sec_mw,
                lower60sec_mw = excluded.lower60sec_mw,
                lower5min_mw = excluded.lower5min_mw,
                lowerreg_mw = excluded.lowerreg_mw,
                lower1sec_mw = excluded.lower1sec_mw,
                initial_energy_storage_mwh = excluded.initial_energy_storage_mwh,
                energy_storage_mwh = excluded.energy_storage_mwh
            """,
            payload,
        )
    return len(payload)


def ingest_archive(path: str | Path, duids: set[str]) -> int:
    """Stream one monthly DISPATCHLOAD archive and keep selected DUIDs."""
    if not duids:
        return 0

    total = 0
    batch: list[tuple] = []
    with zipfile.ZipFile(path) as archive:
        csv_name = next(
            (name for name in archive.namelist() if name.lower().endswith(".csv")),
            None,
        )
        if csv_name is None:
            raise RuntimeError("No CSV in DISPATCHLOAD archive")

        with archive.open(csv_name) as raw:
            import io

            reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8", errors="replace"))
            columns: list[str] | None = None
            positions: dict[str, int] = {}
            for row in reader:
                if len(row) < 5:
                    continue
                # AEMO incremented UNIT_SOLUTION from v5 to v6 during this
                # history window.  Column-name lookup keeps the parser stable
                # across schema versions; do not hardcode the version field.
                if row[0] == "I" and row[1:3] == ["DISPATCH", "UNIT_SOLUTION"]:
                    columns = row[4:]
                    positions = {name: i + 4 for i, name in enumerate(columns)}
                    continue
                if row[0] != "D" or columns is None:
                    continue
                if row[1:3] != ["DISPATCH", "UNIT_SOLUTION"]:
                    continue

                duid = row[positions["DUID"]].strip().strip('"')
                if duid not in duids:
                    continue
                if row[positions["INTERVENTION"]].strip().strip('"') != "0":
                    continue

                settlement = _parse_dt(row[positions["SETTLEMENTDATE"]])
                if settlement is None:
                    continue
                batch.append((
                    settlement,
                    duid,
                    _float(row[positions["INITIALMW"]]),
                    _float(row[positions["TOTALCLEARED"]]),
                    *(_float(row[positions[field]]) for field in FCAS_FIELDS),
                    _float(row[positions.get("INITIAL_ENERGY_STORAGE", -1)])
                    if "INITIAL_ENERGY_STORAGE" in positions else None,
                    _float(row[positions.get("ENERGY_STORAGE", -1)])
                    if "ENERGY_STORAGE" in positions else None,
                ))
                if len(batch) >= 10_000:
                    total += _upsert_rows(batch)
                    batch.clear()
    total += _upsert_rows(batch)
    return total


def download_and_ingest_month(year: int, month: int, region: str = "SA1") -> dict:
    """Download one archive to a temporary file, ingest it, then delete it."""
    candidates = candidate_batteries(region)
    if not candidates:
        raise RuntimeError(f"No registered grid-scale BESS DUIDs for {region}")

    url = _archive_url(year, month)
    headers = {"User-Agent": USER_AGENT}
    with tempfile.NamedTemporaryFile(prefix="dispatchload-", suffix=".zip") as tmp:
        with httpx.stream(
            "GET", url, headers=headers, follow_redirects=True, timeout=300.0
        ) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes(1024 * 1024):
                tmp.write(chunk)
        tmp.flush()
        rows = ingest_archive(tmp.name, set(candidates))

    log.info("BESS actuals %04d-%02d: %d rows", year, month, rows)
    return {
        "month": f"{year}-{month:02d}",
        "rows": rows,
        "duids": sorted(candidates),
    }


def month_range(start: date, end_exclusive: date) -> list[tuple[int, int]]:
    result: list[tuple[int, int]] = []
    current = date(start.year, start.month, 1)
    stop = date(end_exclusive.year, end_exclusive.month, 1)
    while current < stop:
        result.append((current.year, current.month))
        if current.month == 12:
            current = date(current.year + 1, 1, 1)
        else:
            current = date(current.year, current.month + 1, 1)
    return result


def backfill_bess_actuals(
    start: date = date(2025, 7, 1),
    end_exclusive: date = date(2026, 7, 1),
    region: str = "SA1",
) -> dict:
    """Backfill a complete historical comparison window month by month."""
    progress: list[dict] = []
    total_rows = 0
    for year, month in month_range(start, end_exclusive):
        item = download_and_ingest_month(year, month, region)
        progress.append(item)
        total_rows += item["rows"]
    return {
        "region": region.upper(),
        "start": start.isoformat(),
        "end_exclusive": end_exclusive.isoformat(),
        "rows": total_rows,
        "months": progress,
    }
