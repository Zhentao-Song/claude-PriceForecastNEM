"""Fetch and parse ASX Energy public end-of-day electricity reports."""
from __future__ import annotations

import calendar
import html
import re
import ssl
from datetime import datetime, timedelta
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import certifi

ASX_REPORT = "https://www.asx.com.au/data/futures/reports/EODWebMarketSummary{date}SFT.htm"
REGIONS = {
    "NSW": {"code": "BN", "name": "New South Wales"},
    "QLD": {"code": "BQ", "name": "Queensland"},
    "VIC": {"code": "BV", "name": "Victoria"},
    "SA": {"code": "BS", "name": "South Australia"},
}


def _plain(value: str) -> str:
    value = re.sub(r"<[^>]+>", "", value)
    return html.unescape(value).replace("\xa0", " ").strip()


def _number(value: str, *, integer: bool = False) -> float | int | None:
    value = _plain(value).replace(",", "")
    if value in {"", "-"}:
        return None
    try:
        return int(value) if integer else float(value)
    except ValueError:
        return None


def _quarter_hours(expiry: str) -> int | None:
    """Return the MWh exposure of a 1 MW base-load quarter contract."""
    try:
        month_name, year_text = expiry.split()
        end_month = datetime.strptime(month_name, "%b").month
        year = int(year_text)
        days = sum(calendar.monthrange(year, month)[1] for month in range(end_month - 2, end_month + 1))
        return days * 24
    except (ValueError, TypeError):
        return None


def parse_asx_electricity_report(page: str) -> list[dict]:
    """Parse BN/BQ/BV/BS quarterly base-load sections from an ASX report."""
    parsed: list[dict] = []
    for region, meta in REGIONS.items():
        code = meta["code"]
        header = re.search(
            rf'<TR class="Headbold"><TD[^>]*>{code} - ASX Electricity Base Load Quarterly Futures[^<]*</TD></TR>',
            page,
            flags=re.IGNORECASE,
        )
        if not header:
            continue
        next_header = re.search(r'<TR class="Headbold">', page[header.end():], flags=re.IGNORECASE)
        end = header.end() + next_header.start() if next_header else len(page)
        block = page[header.end():end]
        contracts: list[dict] = []
        for row in re.findall(r'<TR class="(?:Highlight|noHighlight)">(.*?)</TR>', block, flags=re.IGNORECASE | re.DOTALL):
            cells = re.findall(r'<TD[^>]*>(.*?)</TD>', row, flags=re.IGNORECASE | re.DOTALL)
            if len(cells) != 10:
                continue
            expiry = _plain(cells[0])
            if not re.fullmatch(r"(?:Mar|Jun|Sep|Dec) \d{4}", expiry):
                continue
            contracts.append({
                "expiry": expiry,
                "open": _number(cells[1]),
                "high": _number(cells[2]),
                "low": _number(cells[3]),
                "last": _number(cells[4]),
                "settlement": _number(cells[5]),
                "change": _number(cells[6]),
                "open_interest": _number(cells[7], integer=True),
                "open_interest_change": _number(cells[8], integer=True),
                "volume": _number(cells[9], integer=True),
                "contract_hours": _quarter_hours(expiry),
            })
        if contracts:
            parsed.append({
                "region": region,
                "region_name": meta["name"],
                "commodity_code": code,
                "contracts": contracts,
            })
    return parsed


def latest_report() -> dict:
    """Return the most recent available report, looking back over weekends."""
    now_sydney = datetime.now(ZoneInfo("Australia/Sydney"))
    last_error = "no report found"
    for offset in range(0, 10):
        report_day = (now_sydney - timedelta(days=offset)).date()
        url = ASX_REPORT.format(date=report_day.strftime("%y%m%d"))
        request = Request(url, headers={"User-Agent": "NEM-WEM-Dashboard/1.0 (+ASX public EOD data)"})
        try:
            ssl_context = ssl.create_default_context(cafile=certifi.where())
            with urlopen(request, timeout=12.0, context=ssl_context) as response:
                page = response.read().decode("utf-8", errors="replace")
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_error = str(exc)
            continue
        regions = parse_asx_electricity_report(page)
        if len(regions) == len(REGIONS):
            return {
                "exchange": "ASX Energy",
                "market": "Australian Electricity Futures",
                "product": "Base Load Quarterly Futures",
                "currency": "AUD",
                "unit": "$/MWh",
                "price_type": "end_of_day_settlement",
                "trading_date": report_day.isoformat(),
                "retrieved_at": now_sydney.isoformat(),
                "source_url": url,
                "regions": regions,
            }
        last_error = f"ASX report {report_day.isoformat()} did not contain all electricity curves"
    raise RuntimeError(last_error)
