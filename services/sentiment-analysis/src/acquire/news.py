"""Financial news acquisition and sentiment scoring from real RSS feeds.

Replaces the previous synthetic generator (``HEADLINE_TEMPLATES`` over
``rng.normal`` with ``example.com`` URLs). Articles come from public RSS feeds
and are scored with NLTK's VADER lexicon.

Provenance per article: ``source_feed`` (feed label), ``source_url`` (original
article URL) and ``sentiment_method`` (``"vader"`` or ``"unavailable"``).

If every configured feed fails, the output is an empty list with
``status = "unavailable"`` — no invented articles.
"""

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Prevent directory from shadowing standard library modules
_script_dir = str(Path(__file__).resolve().parent)
if sys.path and sys.path[0] == _script_dir:
    sys.path.pop(0)

import feedparser
import pandas as pd
import yaml

# VADER is optional at import time: if nltk / vader_lexicon is missing the
# module degrades to status "unavailable" instead of crashing the pipeline.
try:
    from nltk.sentiment.vader import SentimentIntensityAnalyzer

    _VADER = SentimentIntensityAnalyzer()
except Exception:  # pragma: no cover - depends on nltk data availability
    _VADER = None

VADER_POS_THRESHOLD = 0.05
VADER_NEG_THRESHOLD = -0.05
SENTIMENT_METHOD = "vader"
SENTIMENT_UNAVAILABLE = "unavailable"

# Default feeds: keyless public RSS. Mirrors the finance-news skill config.
DEFAULT_RSS_FEEDS = {
    "cnbc_markets": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258",
    "cnbc_business": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069",
    "marketwatch_top": "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    "wsj_markets": "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain",
    "ft_markets": "https://www.ft.com/markets?format=rss",
    "bloomberg_markets": "https://feeds.bloomberg.com/markets/news.rss",
    "investing_com": "https://www.investing.com/rss/news_11.rss",
    # Gold-specific coverage via Google News RSS search (no API key required).
    "gnews_gold": "https://news.google.com/rss/search?q=gold+OR+XAUUSD+OR+%22spot+gold%22+when%3A7d&hl=en-US&gl=US&ceid=US:en",
    "gnews_gold_prices": "https://news.google.com/rss/search?q=%22gold+prices%22+OR+%22gold+futures%22+when%3A7d&hl=en-US&gl=US&ceid=US:en",
}

# Topic keywords used for the `topics` field (no fabricated scores attached).
TOPIC_KEYWORDS = {
    "economy_monetary": ["fed", "fomc", "rate", "interest", "monetary", "powell", "ecb"],
    "economy_macro": ["inflation", "cpi", "pce", "payroll", "nfp", "jobs", "gdp", "recession"],
    "financial_markets": ["stocks", "wall street", "markets", "equities", "bonds", "treasury"],
    "commodities": ["gold", "silver", "oil", "wti", "brent", "commodity", "xauusd"],
    "forex": ["dollar", "usd", "dxy", "currency", "yen", "euro", "forex"],
}


def load_config() -> dict:
    config_path = Path("config.yaml")
    if not config_path.exists():
        config_path = Path("services/sentiment-analysis/config.yaml")
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def score_sentiment(text: str) -> tuple[float | None, str | None, str]:
    """Return (compound_score, label, method). Unavailable when VADER is missing."""
    if _VADER is None:
        return None, None, SENTIMENT_UNAVAILABLE
    scores = _VADER.polarity_scores(text or "")
    compound = float(scores.get("compound", 0.0))
    if compound >= VADER_POS_THRESHOLD:
        label = "Bullish"
    elif compound <= VADER_NEG_THRESHOLD:
        label = "Bearish"
    else:
        label = "Neutral"
    return round(compound, 4), label, SENTIMENT_METHOD


def classify_topics(text: str) -> list[str]:
    lowered = (text or "").lower()
    return [topic for topic, kws in TOPIC_KEYWORDS.items() if any(k in lowered for k in kws)]


def _parse_published(entry) -> datetime | None:
    """Extract a timezone-aware UTC datetime from a feedparser entry."""
    for attr in ("published_parsed", "updated_parsed"):
        parsed = getattr(entry, attr, None)
        if parsed:
            try:
                return datetime(*parsed[:6], tzinfo=timezone.utc)
            except (TypeError, ValueError):
                continue
    raw = getattr(entry, "published", None) or getattr(entry, "updated", None)
    if raw:
        try:
            dt = pd.to_datetime(raw, utc=True).to_pydatetime()
            return dt
        except (ValueError, TypeError):
            return None
    return None


def fetch_feed_articles(
    feed_label: str,
    feed_url: str,
    max_articles: int = 60,
) -> list[dict]:
    """Parse one RSS feed into raw article dicts. Empty list on failure."""
    try:
        parsed = feedparser.parse(
            feed_url,
            request_headers={
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            },
        )
    except Exception as exc:
        print(f"[News] feed {feed_label} failed to parse: {exc}")
        return []

    if parsed.bozo and not parsed.entries:
        print(f"[News] feed {feed_label} unavailable: {getattr(parsed, 'bozo_exception', 'unknown')}")
        return []

    articles: list[dict] = []
    for entry in parsed.entries[:max_articles]:
        link = getattr(entry, "link", None)
        title = (getattr(entry, "title", "") or "").strip()
        if not link or not title:
            continue
        published = _parse_published(entry)
        summary = (getattr(entry, "summary", "") or "").strip()
        source_name = ""
        if getattr(entry, "source", None):
            source_name = getattr(entry.source, "title", "") or ""
        articles.append(
            {
                "title": title,
                "summary": summary,
                "link": link,
                "published": published,
                "publisher": source_name,
            }
        )
    print(f"[News] {feed_label}: {len(articles)} articles")
    return articles


def acquire_news_sentiment(
    output_dir: str = "data/raw/news",
    output_file: str = "news_sentiment_feed.json",
    feeds: dict[str, str] | None = None,
    max_articles_per_feed: int = 60,
    lookback_days: int = 14,
    calendar_path: str | None = None,
    corpus_path: str = "data/processed/news_corpus.jsonl",
    seed: int | None = None,  # kept for backwards-compatible signatures; unused
) -> list[dict]:
    """Acquire real RSS articles, score them with VADER, and persist.

    Output JSON is a dict: ``{"status": "ok"|"unavailable", "articles": [...],
    "feeds": {...}}``. When no feed yields articles the status is ``unavailable``
    and ``articles`` is empty.
    """
    os.makedirs(output_dir, exist_ok=True)
    feeds = feeds or DEFAULT_RSS_FEEDS

    print("[News] Fetching real RSS feeds (no synthetic articles)...")
    collected: list[dict] = []
    feed_status: dict[str, str] = {}

    cutoff = datetime.now(timezone.utc) - pd.Timedelta(days=lookback_days)

    for label, url in feeds.items():
        raw = fetch_feed_articles(label, url, max_articles=max_articles_per_feed)
        feed_status[label] = f"ok:{len(raw)}" if raw else "unavailable:0 articles"
        for item in raw:
            published = item["published"]
            if published is None:
                # Undated entries cannot be aligned point-in-time; skip them.
                continue
            if published < cutoff:
                continue

            text = f"{item['title']} {item['summary']}".strip()
            score, label_sent, method = score_sentiment(text)
            article_id = hashlib.sha1(
                f"{item['link']}|{published.isoformat()}".encode("utf-8")
            ).hexdigest()[:16]

            collected.append(
                {
                    "id": article_id,
                    "title": item["title"],
                    "summary": item["summary"],
                    "time_published_utc": published.strftime("%Y-%m-%d %H:%M:%S+00:00"),
                    "overall_sentiment_score": score,
                    "overall_sentiment_label": label_sent,
                    "topics": classify_topics(text) or ["financial_markets"],
                    "url": item["link"],
                    "source_feed": label,
                    "source_url": item["link"],
                    "publisher": item["publisher"],
                    "sentiment_method": method,
                    "related_event": None,
                }
            )

    # De-duplicate identical URLs, keep the earliest publication time.
    seen: dict[str, dict] = {}
    for art in collected:
        key = art["url"]
        if key not in seen or art["time_published_utc"] < seen[key]["time_published_utc"]:
            seen[key] = art
    articles = sorted(seen.values(), key=lambda a: a["time_published_utc"])

    status = "ok" if articles else "unavailable"
    payload = {
        "status": status,
        "status_reason": None if articles else "no feed returned articles",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S+00:00"),
        "sentiment_method": SENTIMENT_METHOD if _VADER is not None else SENTIMENT_UNAVAILABLE,
        "feeds": feed_status,
        "article_count": len(articles),
        "articles": articles,
    }

    out_path = os.path.join(output_dir, output_file)
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2)

    print(
        f"[News] Saved {len(articles)} real articles to {out_path} "
        f"(status={status}, feeds={len(feed_status)})."
    )

    # Append to the persistent corpus so history accumulates across runs instead
    # of being reset every 14-day window.
    try:
        from src.acquire.corpus import append_articles, corpus_stats

        added = append_articles(corpus_path, articles)
        stats = corpus_stats(corpus_path)
        print(
            f"[News] Corpus: +{added} artikel baru "
            f"(total {stats['articles']}, {stats['first']} .. {stats['last']})."
        )
    except Exception as exc:  # noqa: BLE001 - corpus is an enhancement, not a blocker
        print(f"[News] Corpus update dilewati: {type(exc).__name__}: {exc}")

    return articles


def write_news_provenance(
    news_json: str = "data/raw/news/news_sentiment_feed.json",
) -> dict:
    """Build the news entry of the provenance manifest."""
    with open(news_json, "r") as f:
        payload = json.load(f)
    articles = payload.get("articles", [])
    return {
        "artifact": news_json,
        "source": "rss_feeds (keyless)",
        "generated_at": payload.get("generated_at"),
        "as_of": payload.get("generated_at"),
        "is_simulated": len(articles) == 0,
        "status": payload.get("status", "unavailable"),
        "article_count": len(articles),
        "sentiment_method": payload.get("sentiment_method", SENTIMENT_UNAVAILABLE),
        "feeds": payload.get("feeds", {}),
    }


if __name__ == "__main__":
    cfg = load_config()
    out_dir = cfg["data"]["news_dir_raw"]
    acquire_news_sentiment(
        output_dir=out_dir,
        feeds=cfg.get("news", {}).get("rss_feeds", DEFAULT_RSS_FEEDS),
        max_articles_per_feed=cfg.get("news", {}).get("max_articles_per_feed", 60),
        lookback_days=cfg.get("news", {}).get("lookback_days", 14),
        corpus_path=cfg.get("data", {}).get("news_corpus", "data/processed/news_corpus.jsonl"),
    )
