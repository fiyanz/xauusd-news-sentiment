"""Persistent news corpus: append-only, deduplicated by URL.

RSS feeds only expose the last ~14 days, so a pipeline that overwrites the news
file every run can never grow its sample. This module keeps a rolling corpus in
JSONL form; every acquisition (RSS, GDELT) appends new articles and dedupes by
URL, so the harmonizer can align a growing history instead of a fixed window.
"""

import json
import os

CORPUS_PATH = "data/processed/news_corpus.jsonl"


def load_corpus(path: str = CORPUS_PATH) -> list[dict]:
    """Read a JSONL corpus. Missing file -> empty list (no invented articles)."""
    if not os.path.exists(path):
        return []
    articles: list[dict] = []
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                articles.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return articles


def write_corpus(path: str, articles: list[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    ordered = sorted(articles, key=lambda a: a.get("time_published_utc") or "")
    with open(path, "w") as f:
        for a in ordered:
            f.write(json.dumps(a, ensure_ascii=False) + "\n")


def merge_articles(existing: list[dict], new: list[dict]) -> list[dict]:
    """Dedupe by URL (falling back to id), keeping the earliest publication time."""
    seen: dict[str, dict] = {}
    for art in list(existing) + list(new):
        key = art.get("url") or art.get("id")
        if not key:
            continue
        cur = seen.get(key)
        if cur is None or (art.get("time_published_utc") or "") < (cur.get("time_published_utc") or ""):
            seen[key] = art
    return sorted(seen.values(), key=lambda a: a.get("time_published_utc") or "")


def append_articles(path: str, new: list[dict]) -> int:
    """Append new articles to the corpus; return the number of genuinely new rows."""
    existing = load_corpus(path)
    merged = merge_articles(existing, new)
    write_corpus(path, merged)
    return len(merged) - len(existing)


def corpus_stats(path: str = CORPUS_PATH) -> dict:
    articles = load_corpus(path)
    if not articles:
        return {"articles": 0, "first": None, "last": None}
    times: list[str] = []
    for a in articles:
        t = a.get("time_published_utc")
        if isinstance(t, str):
            times.append(t)
    return {
        "articles": len(articles),
        "first": min(times) if times else None,
        "last": max(times) if times else None,
    }
