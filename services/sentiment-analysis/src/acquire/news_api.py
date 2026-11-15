"""Ambil berita emas berisi (title + description + content) dari API berita.

Sumber:
- newsapi.org  (NEWS_API_KEY)   : berita terkini, 100 request/hari.
- GNews        (GNEWS_API_KEY)  : berita terkini, 100 request/hari.

Kedua API menyediakan isi berita (description/content), bukan cuma judul —
ini memperkaya representasi teks untuk analisis sentimen.
"""

import json
import os
import time
import urllib.parse
import urllib.request

from src.acquire.corpus import append_articles
from src.acquire.news import classify_topics, score_sentiment

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"}


def _load_env(path: str = "../../.env") -> dict:
    """Baca key dari .env repo root."""
    env = dict(os.environ)
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return env


def _to_article(title: str, body: str, url: str, published: str, feed: str) -> dict | None:
    if not title or not published:
        return None
    score, label, method = score_sentiment(f"{title} {body}")
    import hashlib

    article_id = feed + ":" + hashlib.sha1(f"{title}|{published}".encode("utf-8")).hexdigest()[:16]
    return {
        "id": article_id,
        "title": title,
        "summary": body or "",
        "time_published_utc": published,
        "overall_sentiment_score": score,
        "overall_sentiment_label": label,
        "topics": classify_topics(f"{title} {body}") or ["financial_markets"],
        "url": url or "",
        "source_feed": feed,
        "source_url": url,
        "publisher": "",
        "sentiment_method": method,
        "related_event": None,
    }


def fetch_newsapi_org(
    corpus_path: str = "data/processed/news_corpus.jsonl",
    query: str = "gold XAUUSD",
    max_pages: int = 20,
    page_size: int = 100,
    delay: float = 1.2,
) -> int:
    """Ambil dari newsapi.org (berita terkini)."""
    env = _load_env()
    key = env.get("NEWS_API_KEY")
    if not key:
        print("[NewsAPI.org] NEWS_API_KEY tidak ada.")
        return 0

    collected: list[dict] = []
    for page in range(1, max_pages + 1):
        url = "https://newsapi.org/v2/everything?" + urllib.parse.urlencode(
            {
                "q": query,
                "pageSize": page_size,
                "page": page,
                "sortBy": "publishedAt",
                "language": "en",
                "apiKey": key,
            }
        )
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8", errors="replace"))
        except Exception as exc:  # noqa: BLE001
            print(f"[NewsAPI.org] page {page} gagal: {type(exc).__name__}: {exc}")
            break

        if data.get("status") != "ok":
            print(f"[NewsAPI.org] page {page}: {data.get('code')} {data.get('message')}")
            break

        arts = data.get("articles", [])
        if not arts:
            break
        for a in arts:
            title = (a.get("title") or "").strip()
            body = (a.get("description") or a.get("content") or "").strip()
            if not title or title.lower() == "[removed]":
                continue
            art = _to_article(title, body, a.get("url", ""), a.get("publishedAt", ""), "newsapi_org")
            if art:
                collected.append(art)
        print(f"[NewsAPI.org] page {page}: {len(arts)} artikel (total {len(collected)})")
        if len(arts) < page_size:
            break
        time.sleep(delay)

    if not collected:
        return 0
    added = append_articles(corpus_path, collected)
    print(f"[NewsAPI.org] +{added} artikel berisi baru di korpus.")
    return added


def fetch_gnews(
    corpus_path: str = "data/processed/news_corpus.jsonl",
    query: str = "gold XAUUSD",
    max_pages: int = 20,
    page_size: int = 100,
    delay: float = 1.2,
) -> int:
    """Ambil dari GNews (berita terkini)."""
    env = _load_env()
    key = env.get("GNEWS_API_KEY")
    if not key:
        print("[GNews] GNEWS_API_KEY tidak ada.")
        return 0

    collected: list[dict] = []
    for page in range(1, max_pages + 1):
        url = "https://gnews.io/api/v4/search?" + urllib.parse.urlencode(
            {
                "q": query,
                "lang": "en",
                "max": page_size,
                "page": page,
                "apikey": key,
            }
        )
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8", errors="replace"))
        except Exception as exc:  # noqa: BLE001
            print(f"[GNews] page {page} gagal: {type(exc).__name__}: {exc}")
            break

        if data.get("errors"):
            print(f"[GNews] page {page}: {data['errors']}")
            break

        arts = data.get("articles", [])
        if not arts:
            break
        for a in arts:
            title = (a.get("title") or "").strip()
            body = (a.get("content") or a.get("description") or "").strip()
            if not title:
                continue
            art = _to_article(title, body, a.get("url", ""), a.get("publishedAt", ""), "gnews")
            if art:
                collected.append(art)
        print(f"[GNews] page {page}: {len(arts)} artikel (total {len(collected)})")
        if len(arts) < page_size:
            break
        time.sleep(delay)

    if not collected:
        return 0
    added = append_articles(corpus_path, collected)
    print(f"[GNews] +{added} artikel berisi baru di korpus.")
    return added


if __name__ == "__main__":
    # Beberapa query untuk menjangkau emas, dolar AS, dan kebijakan Fed.
    queries = [
        "gold XAUUSD",
        "US dollar index DXY",
        "Federal Reserve interest rate decision",
        "US inflation CPI",
        "US Treasury yield",
    ]
    total = 0
    for q in queries:
        print(f"\n=== query: {q} ===")
        total += fetch_newsapi_org(query=q, max_pages=1)
        total += fetch_gnews(query=q, max_pages=2)
    print(f"\nTotal artikel baru: {total}")
