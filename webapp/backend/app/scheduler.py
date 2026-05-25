"""Background scheduler that polls NEMWeb + WEM data sources."""
from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from . import paper, vpp_settle, vpp_telemetry
from .config import POLL_INTERVAL_SECONDS
from .db import locked_conn
from .scrapers import backfill, bids, nem, predispatch, scada, wem

log = logging.getLogger("scheduler")

_scheduler: AsyncIOScheduler | None = None
_latest_status: dict = {
    "nem": {}, "wem": {}, "scada": {}, "predispatch": {}, "bids": {},
}


async def _tick_nem() -> None:
    try:
        res = await nem.run_once()
        _latest_status["nem"] = res
        log.info("NEM tick: %s", res)
    except Exception as e:
        log.exception("NEM tick failed")
        _latest_status["nem"] = {"error": str(e)}
    # Settle paper bids whenever new prices may have arrived. Cheap and
    # idempotent — only PENDING bids whose target interval now has a price
    # are touched.
    try:
        paper.settle_pending()
    except Exception:
        log.exception("paper settlement failed")
    # Same idempotent settlement for the VPP fleet.
    try:
        res = vpp_settle.settle_pending()
        if res.get("settled", 0) > 0:
            log.info("VPP settle: %s", res)
    except Exception:
        log.exception("vpp settlement failed")
    # Telemetry simulator — keeps EV availability + BESS SoC drifting
    # toward operator-style targets so the UI looks alive when the user
    # isn't actively trading.
    try:
        vpp_telemetry.tick()
    except Exception:
        log.exception("vpp telemetry tick failed")


async def _tick_wem() -> None:
    try:
        res = await wem.run_once()
        _latest_status["wem"] = res
        log.info("WEM tick: %s", res)
    except Exception as e:
        log.exception("WEM tick failed")
        _latest_status["wem"] = {"error": str(e)}


async def _tick_scada() -> None:
    try:
        res = await scada.run_once()
        _latest_status["scada"] = res
        log.info("SCADA tick: %s", res)
    except Exception as e:
        log.exception("SCADA tick failed")
        _latest_status["scada"] = {"error": str(e)}


async def _maybe_backfill() -> None:
    """On boot, if the local DB has < ~30 days of dispatch history, kick off
    the 90-day archive backfill. Heatmap / weekly-view charts are useless
    without this. Runs once, in the background — startup isn't blocked.
    """
    try:
        with locked_conn() as con:
            row = con.execute(
                "SELECT COUNT(DISTINCT substr(settlementdate,1,10)) "
                "FROM nem_dispatch_price"
            ).fetchone()
        days_present = int(row[0]) if row else 0
        if days_present >= 30:
            log.info("backfill skipped: %d days of dispatch history present", days_present)
            return
        log.info("backfill: only %d days present, pulling 90-day archive", days_present)
        res = await backfill.backfill_days(days=90)
        _latest_status["backfill"] = res
        log.info(
            "backfill complete: downloaded=%d skipped=%d rows_price=%d",
            res.get("downloaded", 0), res.get("skipped", 0), res.get("rows_price", 0),
        )
    except Exception as e:
        log.exception("backfill failed")
        _latest_status["backfill"] = {"error": str(e)}


async def _tick_predispatch() -> None:
    """AEMO publishes P5MIN every 5 min and PREDISPATCHIS every 30 min.
    We poll on the faster cadence; PREDISPATCHIS calls just return 0
    new files when nothing's there."""
    try:
        res = await predispatch.run_once()
        _latest_status["predispatch"] = res
        log.info("predispatch tick: %s", res)
    except Exception as e:
        log.exception("predispatch tick failed")
        _latest_status["predispatch"] = {"error": str(e)}


async def _tick_bids() -> None:
    """BIDDAYOFFER / BIDPEROFFER feeds. The day-ahead snapshot only refreshes
    once a day (~12:30 the day before); BIDMOVE_SUMMARY captures rebids as
    they happen. We poll on the slower cadence — chasing every 5-min rebid
    would burn bandwidth for marginal value, and a 1-2 min lag on the bid
    stack visualisation is fine."""
    try:
        res = await bids.run_once()
        _latest_status["bids"] = res
        log.info("bids tick: %s", res)
    except Exception as e:
        log.exception("bids tick failed")
        _latest_status["bids"] = {"error": str(e)}


def start() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = AsyncIOScheduler()
    _scheduler.add_job(_tick_nem, "interval", seconds=POLL_INTERVAL_SECONDS, id="nem", max_instances=1)
    _scheduler.add_job(_tick_wem, "interval", seconds=POLL_INTERVAL_SECONDS * 5, id="wem", max_instances=1)
    _scheduler.add_job(_tick_scada, "interval", seconds=POLL_INTERVAL_SECONDS, id="scada", max_instances=1)
    _scheduler.add_job(
        _tick_predispatch, "interval",
        seconds=POLL_INTERVAL_SECONDS * 5, id="predispatch", max_instances=1,
    )
    # Bids: BIDMOVE_SUMMARY updates a few times per hour during the trading
    # day, day-ahead Next_Day_Offer only refreshes ~12:30pm. Polling every
    # 5 min is plenty.
    _scheduler.add_job(
        _tick_bids, "interval",
        seconds=POLL_INTERVAL_SECONDS * 5, id="bids", max_instances=1,
    )
    _scheduler.start()
    # Kick off immediately so the dashboard isn't empty on first load.
    asyncio.create_task(_tick_nem())
    asyncio.create_task(_tick_wem())
    asyncio.create_task(_tick_scada())
    asyncio.create_task(_tick_predispatch())
    asyncio.create_task(_tick_bids())
    # Heatmap and 7-day chart views need historical depth that the live
    # scraper can't provide on its own. Launch the archive backfill in the
    # background — it's a no-op once the DB is populated.
    asyncio.create_task(_maybe_backfill())


def stop() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None


def status() -> dict:
    return _latest_status
