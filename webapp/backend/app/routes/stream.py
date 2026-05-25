"""SSE endpoint pushing latest snapshot every ~30s."""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

from .prices import snapshot

router = APIRouter(prefix="/api", tags=["stream"])

PUSH_INTERVAL = 30  # seconds


@router.get("/stream")
async def stream():
    async def event_gen():
        while True:
            try:
                payload = snapshot()
                yield {"event": "snapshot", "data": json.dumps(payload, default=str)}
            except Exception as e:
                yield {"event": "error", "data": json.dumps({"error": str(e)})}
            await asyncio.sleep(PUSH_INTERVAL)

    return EventSourceResponse(event_gen())
