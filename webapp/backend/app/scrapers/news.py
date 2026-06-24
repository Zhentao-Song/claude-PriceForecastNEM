"""Australian energy-market news aggregator.

Pulls public RSS feeds from the major AU energy/renewables outlets, parses
each item, and upserts into nem_news. Every row links back to the original
article — we store a plain-text excerpt for the card, never the full body
(that stays on the publisher's site).

Feeds (all public RSS, no key):
  RenewEconomy        — flagship AU renewables / NEM news
  pv-magazine AU      — solar + storage
  Energy Magazine     — broader AU energy industry / utilities
  The Driven          — EVs + transport electrification

Polled hourly; pruned to the latest ~200 articles.
"""
from __future__ import annotations

import html
import json
import logging
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx

from ..config import HTTP_TIMEOUT
from ..db import write_conn
from .nem import set_state

log = logging.getLogger("scraper.news")

# Browser-ish UA — some CDNs 202/403 a bare httpx client.
_UA = "Mozilla/5.0 (compatible; NEMDashboard/1.0; +https://nemweb.com.au)"

FEEDS: list[tuple[str, str]] = [
    ("RenewEconomy",    "https://reneweconomy.com.au/feed/"),
    ("pv-magazine AU",  "https://www.pv-magazine-australia.com/feed/"),
    ("Energy Magazine", "https://www.energymagazine.com.au/feed/"),
    ("The Driven",      "https://thedriven.io/feed/"),
]

KEEP_ARTICLES = 200

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_IMG_RE = re.compile(r'<img[^>]+src="([^"]+)"', re.IGNORECASE)


def _clean_text(raw: str | None, limit: int = 280) -> str:
    if not raw:
        return ""
    txt = html.unescape(_TAG_RE.sub(" ", raw))
    txt = _WS_RE.sub(" ", txt).strip()
    return txt[:limit]


def _first_image(description: str | None, item: ET.Element, ns: dict) -> str | None:
    # 1) <media:content> / <media:thumbnail>
    for tag in ("{http://search.yahoo.com/mrss/}content",
                "{http://search.yahoo.com/mrss/}thumbnail"):
        el = item.find(tag)
        if el is not None and el.get("url"):
            return el.get("url")
    # 2) <enclosure url=… type=image/*>
    enc = item.find("enclosure")
    if enc is not None and (enc.get("type") or "").startswith("image"):
        return enc.get("url")
    # 3) first <img> inside the description HTML
    if description:
        m = _IMG_RE.search(description)
        if m:
            return m.group(1)
    return None


def _parse_date(s: str | None) -> str | None:
    if not s:
        return None
    try:
        dt = parsedate_to_datetime(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError):
        return None


def _text(item: ET.Element, tag: str, ns: dict | None = None) -> str | None:
    el = item.find(tag, ns) if ns else item.find(tag)
    return el.text if el is not None else None


def parse_feed(source: str, xml_bytes: bytes) -> list[dict]:
    ns = {
        "dc": "http://purl.org/dc/elements/1.1/",
        "content": "http://purl.org/rss/1.0/modules/content/",
    }
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        log.warning("news %s parse error: %s", source, e)
        return []

    out: list[dict] = []
    for item in root.iter("item"):
        link = (_text(item, "link") or "").strip()
        title = _clean_text(_text(item, "title"), 300)
        if not link or not title:
            continue
        description = _text(item, "description") or _text(item, "content:encoded", ns)
        cats = [c.text.strip() for c in item.findall("category")
                if c.text and c.text.strip()][:5]
        out.append({
            "url": link,
            "title": title,
            "source": source,
            "author": (_text(item, "dc:creator", ns) or "").strip() or None,
            "published_at": _parse_date(_text(item, "pubDate")),
            "summary": _clean_text(description),
            "image_url": _first_image(description, item, ns),
            "categories": json.dumps(cats, ensure_ascii=False) if cats else None,
        })
    return out


def upsert_news(rows: list[dict]) -> int:
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    payload = [(
        r["url"], r["title"], r["source"], r["author"], r["published_at"],
        r["summary"], r["image_url"], r["categories"], now,
    ) for r in rows]
    with write_conn() as con:
        con.executemany(
            """
            INSERT INTO nem_news
                (url, title, source, author, published_at,
                 summary, image_url, categories, fetched_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(url) DO UPDATE SET
                title=excluded.title, summary=excluded.summary,
                image_url=excluded.image_url, categories=excluded.categories
            """,
            payload,
        )
        con.execute(
            """
            DELETE FROM nem_news WHERE url NOT IN (
                SELECT url FROM nem_news
                ORDER BY published_at DESC LIMIT ?
            )
            """,
            (KEEP_ARTICLES,),
        )
    return len(payload)


async def run_once() -> dict:
    headers = {"User-Agent": _UA, "Accept": "application/rss+xml, application/xml, text/xml"}
    total = 0
    per_source: dict[str, int] = {}
    errors: list[str] = []
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        for source, url in FEEDS:
            try:
                r = await client.get(url, timeout=HTTP_TIMEOUT)
                r.raise_for_status()
                rows = parse_feed(source, r.content)
                n = upsert_news(rows)
                per_source[source] = n
                total += n
            except Exception as e:
                log.warning("news %s failed: %s", source, e)
                errors.append(f"{source}: {e}")

    set_state("nem_news", f"{total} articles" if total else None,
              error="; ".join(errors) or None)
    if total:
        log.info("news: %d articles from %d feeds", total, len(per_source))
    return {"articles": total, "per_source": per_source,
            "errors": errors or None}
