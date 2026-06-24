"""Scheduler process entrypoint.

Runs all the scrapers (the heavy SQLite writers) in a SEPARATE process from the
API. SQLite WAL lets the API process read concurrently while this process is the
single writer, so a write stall here can NEVER freeze the API (different process,
different event loop).

A watchdog thread — independent of the asyncio loop, so it keeps running even if
the loop is blocked on a synchronous DB call — restarts the process if the
scheduler stops making progress (e.g. a write deadlock). The supervisor (honcho
in prod, docker-compose restart in dev) brings it back up.
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
import time

from . import scheduler
from .db import get_conn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("run_scheduler")

# Restart the process if no NEM tick has completed for this long. NEM ticks run
# every 60s, so 7 min of silence means the loop/writer is wedged. os._exit
# bypasses a (possibly stuck) interpreter shutdown and lets the supervisor
# restart us cleanly.
WATCHDOG_TIMEOUT_S = int(os.getenv("SCHEDULER_WATCHDOG_S", "420"))


def _watchdog() -> None:
    time.sleep(WATCHDOG_TIMEOUT_S)  # startup grace (first ticks / any backfill)
    while True:
        stale = scheduler.seconds_since_progress()
        if stale > WATCHDOG_TIMEOUT_S:
            log.error(
                "watchdog: no scheduler progress for %.0fs (> %ds) — exiting for restart",
                stale, WATCHDOG_TIMEOUT_S,
            )
            os._exit(1)
        time.sleep(30)


async def main() -> None:
    get_conn()  # initialise schema (idempotent)
    scheduler.start()
    threading.Thread(target=_watchdog, name="scheduler-watchdog", daemon=True).start()
    log.info("scheduler process started (watchdog timeout %ds)", WATCHDOG_TIMEOUT_S)
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
