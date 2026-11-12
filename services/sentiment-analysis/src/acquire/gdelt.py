"""GDELT Doc API historical news (keyless, rate-limited ~1 request / 5 seconds).

RSS feeds only expose the last ~14 days. GDELT is the keyless historical news
archive; this module pulls articles in time windows and appends them to the same
persistent corpus as the RSS acquisition, so the sample grows instead of resetting.

The API is aggressively rate limited. The module throttles requests, stops on the
first rate-limit response, and never crashes the pipeline: on failure it returns
0 new articles and the RSS-only corpus is still used.
"""

import hashlib
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from src.acquire.corpus import append_articles
from src.acquire.news import classify_topics, score_sentiment

GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
DEFAULT_QUERY = "gold futures language:eng"
REQUEST_INTERVAL = 6.5  # GDELT asks for >= 5s between requests
RATE_LIMIT_MARKER = "Please limit requests"


def _parse_seendate(value) -> datetime | None:
    """Parse GDELT ``seendate`` (e.g. ``20260104T024500Z``) to aware UTC."""
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y-%m-%dT%H:%M:%SZ", "%Y%m%d%H%M%S"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _parse_date(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    try:
        return datetime.fromisoformat(str(value)).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _fetch_window(query: str, start: datetime, end: datetime, max_records: int) -> list[dict]:
    params = {
        "query": query,
        "mode": "ArtList",
        "format": "json",
        "maxrecords": str(max_records),
        "startdatetime": start.strftime("%Y%m%d%H%M%S"),
        "enddatetime": end.strftime("%Y%m%d%H%M%S"),
    }
    url = GDELT_DOC_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"},
    )
    with urllib.request.urlopen(req, timeout=40) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    if RATE_LIMIT_MARKER in body:
        raise RuntimeError("GDELT rate limit reached")
    payload = json.loads(body)
    return payload.get("articles", []) if isinstance(payload, dict) else []


def _to_article(item: dict, feed_label: str = "gdelt") -> dict | None:
    url = item.get("url") or item.get("domain")
    title = (item.get("title") or "").strip()
    published = _parse_seendate(item.get("seendate"))
    if not url or not title or published is None:
        return None
    score, label, method = score_sentiment(title)
    article_id = hashlib.sha1(f"{url}|{published.isoformat()}".encode("utf-8")).hexdigest()[:16]
    return {
        "id": article_id,
        "title": title,
        "summary": "",
        "time_published_utc": published.strftime("%Y-%m-%d %H:%M:%S+00:00"),
        "overall_sentiment_score": score,
        "overall_sentiment_label": label,
        "topics": classify_topics(title) or ["financial_markets"],
        "url": url,
        "source_feed": feed_label,
        "source_url": url,
        "publisher": item.get("domain") or "",
        "sentiment_method": method,
        "related_event": None,
    }


def fetch_gdelt_articles(
    corpus_path: str = "data/processed/news_corpus.jsonl",
    query: str = DEFAULT_QUERY,
    start_date=None,
    end_date=None,
    max_records: int = 250,
    window_days: int = 31,
    max_windows: int = 12,
    delay: float = REQUEST_INTERVAL,
) -> int:
    """Fetch GDELT articles in time windows and append them to the corpus.

    Returns the number of genuinely new articles added. Rate limited: stops at
    the first failure and returns whatever was added so far (possibly 0).
    """
    start = _parse_date(start_date) or (datetime.now(timezone.utc) - timedelta(days=365))
    end = _parse_date(end_date) or datetime.now(timezone.utc)
    if start >= end:
        print("[GDELT] start_date >= end_date; tidak ada jendela.")
        return 0

    collected: list[dict] = []
    window_start = start
    windows = 0
    while window_start < end and windows < max_windows:
        window_end = min(window_start + timedelta(days=window_days), end)
        try:
            items = _fetch_window(query, window_start, window_end, max_records)
        except Exception as exc:  # noqa: BLE001 - rate limit / network; stop cleanly
            print(f"[GDELT] jendela {window_start.date()} berhenti: {type(exc).__name__}: {exc}")
            break
        for item in items:
            art = _to_article(item)
            if art:
                collected.append(art)
        windows += 1
        print(f"[GDELT] {window_start.date()}..{window_end.date()}: {len(items)} artikel (total {len(collected)})")
        if window_end >= end or windows >= max_windows:
            break
        window_start = window_end
        time.sleep(delay)

    if not collected:
        print("[GDELT] tidak ada artikel baru.")
        return 0
    added = append_articles(corpus_path, collected)
    print(f"[GDELT] +{added} artikel baru di korpus (total {len(collected)} dikumpulkan).")
    return added


if __name__ == "__main__":
    fetch_gdelt_articles()
