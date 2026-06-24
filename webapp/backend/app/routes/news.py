"""Energy-market news feed (RSS aggregation)."""
from __future__ import annotations

import json

from fastapi import APIRouter, Query

from ..db import locked_conn

router = APIRouter(prefix="/api", tags=["news"])


@router.get("/news")
def news(
    limit: int = Query(60, ge=1, le=200),
    source: str | None = Query(None, description="Filter by feed source"),
) -> dict:
    sql = """
        SELECT url, title, source, author, published_at,
               summary, image_url, categories
        FROM nem_news
    """
    params: list = []
    if source:
        sql += " WHERE source = ?"
        params.append(source)
    sql += " ORDER BY published_at DESC LIMIT ?"
    params.append(limit)

    with locked_conn() as con:
        rows = con.execute(sql, params).fetchall()
        sources = [r[0] for r in con.execute(
            "SELECT DISTINCT source FROM nem_news ORDER BY source"
        ).fetchall()]

    articles = [{
        "url": r[0],
        "title": r[1],
        "source": r[2],
        "author": r[3],
        "published_at": r[4],
        "summary": r[5],
        "image_url": r[6],
        "categories": json.loads(r[7]) if r[7] else [],
    } for r in rows]

    return {"articles": articles, "sources": sources, "count": len(articles)}
