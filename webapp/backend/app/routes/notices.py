"""Market notices feed — powers the scrolling event ticker."""
from __future__ import annotations

from fastapi import APIRouter, Query

from ..db import locked_conn

router = APIRouter(prefix="/api", tags=["notices"])


@router.get("/notices")
def notices(
    limit: int = Query(40, ge=1, le=200),
    notice_type: str | None = Query(None, description="Filter by Notice Type ID substring"),
) -> dict:
    sql = """
        SELECT notice_id, notice_type, type_description, creation_date,
               external_ref, reason
        FROM nem_market_notice
    """
    params: list = []
    if notice_type:
        sql += " WHERE notice_type LIKE ?"
        params.append(f"%{notice_type.upper()}%")
    sql += " ORDER BY notice_id DESC LIMIT ?"
    params.append(limit)

    with locked_conn() as con:
        rows = con.execute(sql, params).fetchall()

    return {
        "notices": [
            {
                "notice_id": r[0],
                "notice_type": r[1],
                "type_description": r[2],
                "creation_date": r[3],
                "external_ref": r[4],
                "reason": r[5],
            }
            for r in rows
        ],
    }
