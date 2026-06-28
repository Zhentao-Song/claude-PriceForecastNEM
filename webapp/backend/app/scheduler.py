"""Background scheduler that polls NEMWeb + WEM data sources."""
from __future__ import annotations

import asyncio
import logging
import os
import time

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from . import paper, vpp_settle, vpp_telemetry
from .config import POLL_INTERVAL_SECONDS
from .db import locked_conn
from .forecast import eval as fc_eval
from .forecast import ml as fc_ml
from .scrapers import (
    backfill, bids, facilities, market_notices, nem, news, predispatch, pasa,
    rooftop_pv, scada, wem,
)

log = logging.getLogger("scheduler")

_scheduler: AsyncIOScheduler | None = None
_latest_status: dict = {
    "nem": {}, "wem": {}, "scada": {}, "predispatch": {}, "bids": {}, "pasa": {},
    "rooftop_pv": {}, "facilities": {}, "market_notices": {}, "news": {},
    "forecast": {},
}

# Liveness heartbeat: updated at the end of every NEM tick (every 60s). The
# scheduler-process watchdog reads seconds_since_progress() — if a write
# deadlock freezes the event loop, the NEM tick can't update this and the
# watchdog restarts the process. (NEM tick writes via the single writer, so a
# fresh heartbeat also proves the writer isn't stuck.)
_last_progress: float = time.time()


def seconds_since_progress() -> float:
    return time.time() - _last_progress


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
    # Mark progress for the watchdog: reaching here means the loop ran and the
    # writer was reachable this cycle.
    global _last_progress
    _last_progress = time.time()


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

    Set DISABLE_BACKFILL=1 to skip (useful on memory-constrained cloud envs).
    """
    if os.getenv("DISABLE_BACKFILL", "").strip().lower() in ("1", "true", "yes"):
        log.info("backfill: disabled by DISABLE_BACKFILL env var, skipping")
        return
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


async def _tick_pasa() -> None:
    """ST PASA is published hourly — poll every 30 min. File-level dedup
    ensures re-runs are cheap when no new file is available."""
    try:
        res = await pasa.run_once()
        _latest_status["pasa"] = res
        log.info("PASA tick: %s", res)
    except Exception as e:
        log.exception("PASA tick failed")
        _latest_status["pasa"] = {"error": str(e)}


async def _tick_rooftop_pv() -> None:
    """Rooftop PV is published every 30 min. Poll on the same cadence as
    SCADA (every 60 s) — the file-level dedup means extra polls are cheap
    and we minimise the lag after a new satellite estimate drops."""
    try:
        res = await rooftop_pv.run_once()
        _latest_status["rooftop_pv"] = res
        if res.get("new_files", 0):
            log.info("rooftop_pv tick: %s", res)
    except Exception as e:
        log.exception("rooftop_pv tick failed")
        _latest_status["rooftop_pv"] = {"error": str(e)}


async def _tick_market_notices() -> None:
    """AEMO market notices (LOR, CPT, interventions). New notices arrive a
    few times an hour at most — 5-min polling keeps the ticker fresh."""
    try:
        res = await market_notices.run_once()
        _latest_status["market_notices"] = res
        if res.get("rows", 0):
            log.info("market notices tick: %s", res)
    except Exception as e:
        log.exception("market notices tick failed")
        _latest_status["market_notices"] = {"error": str(e)}


async def _tick_news() -> None:
    """AU energy-market news RSS aggregation. Hourly is plenty — these
    outlets publish a handful of articles a day."""
    try:
        res = await news.run_once()
        _latest_status["news"] = res
        if res.get("articles", 0):
            log.info("news tick: %s", res)
    except Exception as e:
        log.exception("news tick failed")
        _latest_status["news"] = {"error": str(e)}


async def _tick_facilities() -> None:
    """AEMO facility registry (MMSDM archive) — registration data changes
    slowly and the archive only updates monthly, so a weekly pull is plenty."""
    try:
        res = await facilities.run_once()
        _latest_status["facilities"] = res
        log.info("facilities tick: %s", res)
    except Exception as e:
        log.exception("facilities tick failed")
        _latest_status["facilities"] = {"error": str(e)}


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


async def _tick_ml_train() -> None:
    """Retrain the LightGBM price model daily (off-loop). No-op if LightGBM
    isn't installed."""
    if not fc_ml.HAVE_LGB:
        return
    try:
        res = await asyncio.to_thread(fc_ml.train, "NSW1")
        _latest_status["ml_train"] = res
        log.info("ML train: %s", res)
    except Exception as e:
        log.exception("ML train failed")
        _latest_status["ml_train"] = {"error": str(e)}


async def _tick_forecast_log() -> None:
    """Record each forecast model's day-ahead vintage for the next 24h (NSW1).
    Off-loaded to a thread so the DB work never blocks the event loop. INSERT
    OR IGNORE locks the first vintage seen per target, keeping accuracy
    genuinely out-of-sample."""
    try:
        n = await asyncio.to_thread(fc_eval.log_forecasts, "NSW1")
        _latest_status["forecast"] = {"logged": n}
    except Exception as e:
        log.exception("forecast log tick failed")
        _latest_status["forecast"] = {"error": str(e)}


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
    # 5 min is plenty. Set DISABLE_BIDS=1 to skip the bids feed entirely
    # (the BIDPEROFFER ingest/prune on a multi-million-row table can stall the
    # single async worker — useful when the bid table has grown very large).
    _bids_disabled = os.getenv("DISABLE_BIDS", "").strip().lower() in ("1", "true", "yes")
    if not _bids_disabled:
        _scheduler.add_job(
            _tick_bids, "interval",
            seconds=POLL_INTERVAL_SECONDS * 5, id="bids", max_instances=1,
        )
    else:
        log.info("bids: disabled by DISABLE_BIDS env var, skipping")
    # ST PASA: published hourly, poll every 30 min. 1800 s = 30 * 60.
    _scheduler.add_job(
        _tick_pasa, "interval",
        seconds=1800, id="pasa", max_instances=1,
    )
    # Rooftop PV: AEMO publishes one file per 30-min interval (~20 min after
    # the period ends). Polling every 15 min catches each file with at most
    # one wasted request — polling at 60 s was 29 no-op requests per file.
    _scheduler.add_job(
        _tick_rooftop_pv, "interval",
        seconds=900, id="rooftop_pv", max_instances=1,
    )
    # Facility registry: weekly refresh from the MMSDM monthly archive.
    _scheduler.add_job(
        _tick_facilities, "interval",
        seconds=7 * 24 * 3600, id="facilities", max_instances=1,
    )
    # Market notices: every 5 min.
    _scheduler.add_job(
        _tick_market_notices, "interval",
        seconds=POLL_INTERVAL_SECONDS * 5, id="market_notices", max_instances=1,
    )
    # News: hourly RSS pull.
    _scheduler.add_job(
        _tick_news, "interval",
        seconds=3600, id="news", max_instances=1,
    )
    # Forecast vintage logging: every 30 min, mirroring AEMO's PREDISPATCH
    # cadence so each target's day-ahead vintage gets locked on first sight.
    _scheduler.add_job(
        _tick_forecast_log, "interval",
        seconds=1800, id="forecast", max_instances=1,
    )
    # LightGBM price model: retrain daily.
    _scheduler.add_job(
        _tick_ml_train, "interval",
        seconds=24 * 3600, id="ml_train", max_instances=1,
    )
    _scheduler.start()

    # Stagger initial ticks so all scrapers don't hammer AEMO simultaneously
    # at startup (avoids memory spike that can OOM on constrained cloud envs).
    async def _staggered_start() -> None:
        await _tick_nem()
        await asyncio.sleep(4)
        await _tick_scada()
        await asyncio.sleep(4)
        await _tick_predispatch()
        await asyncio.sleep(4)
        if not _bids_disabled:
            await _tick_bids()
            await asyncio.sleep(4)
        await _tick_wem()
        await asyncio.sleep(10)
        await _tick_pasa()
        await asyncio.sleep(4)
        await _tick_rooftop_pv()
        await asyncio.sleep(4)
        # Rooftop PV deep history: if the table holds less than ~5 days of
        # data (5 regions × 48 half-hours × 5 = 1200 rows), pull the weekly
        # ARCHIVE bundles for ~30 days of behind-the-meter history.
        try:
            with locked_conn() as con:
                pv_rows = con.execute(
                    "SELECT COUNT(*) FROM nem_rooftop_pv").fetchone()[0]
            if pv_rows < 1200:
                res = await rooftop_pv.backfill_archive(weeks=5)
                log.info("rooftop_pv archive backfill: %s", res)
        except Exception:
            log.exception("rooftop_pv archive backfill failed")
        await asyncio.sleep(4)
        await _tick_market_notices()
        await asyncio.sleep(4)
        await _tick_news()
        await asyncio.sleep(4)
        # Facility registry: populate on first boot so the fuel mix and
        # station explorer have full-DUID metadata before the weekly job.
        try:
            with locked_conn() as con:
                n_fac = con.execute(
                    "SELECT COUNT(*) FROM nem_facility_registry").fetchone()[0]
            if n_fac < 100:
                await _tick_facilities()
        except Exception:
            log.exception("facilities initial load failed")
        await asyncio.sleep(4)
        # Heatmap and 7-day chart views need historical depth. Backfill runs
        # last, after live scrapers are stable.
        await _maybe_backfill()
        # Forecast page: seed the accuracy panel with a day-ahead backtest of
        # the last week (so it's non-empty on first boot), then log the first
        # live vintage. Runs after backfill so actuals exist to backtest on.
        try:
            await asyncio.to_thread(fc_eval.seed_recent, "NSW1", 7)
            await _tick_forecast_log()
        except Exception:
            log.exception("forecast seed/log failed")
        # Train the LightGBM model on first boot if none exists yet (subsequent
        # retrains happen via the daily ml_train job).
        try:
            if fc_ml.HAVE_LGB and not fc_ml.available("NSW1"):
                await _tick_ml_train()
        except Exception:
            log.exception("forecast ML initial train failed")

    asyncio.create_task(_staggered_start())


def stop() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None


def status() -> dict:
    return _latest_status
