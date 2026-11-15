"""Isi berita (bukan cuma judul) dari dataset yang sudah tersedia.

Masalah: 98% artikel di korpus hanya punya judul (HF financial-news dan GDELT
headlines 2022 tidak menyediakan isi). Dataset berikut menyediakan isi penuh:

- ``ashraq/financial-news-articles`` (2018): kolom ``title``, ``text``, ``url``.
- ``openalphalab/gdelt-news`` (2020, 2026): kolom ``date``, ``language``,
  ``source_url``, ``text``.

Modul ini mengambil artikel emas dari keduanya dan menambahkolom ``body``
(isi berita) ke korpus, sehingga representasi teks (TF-IDF/embedding) jauh
lebih kaya daripada judul saja.
"""

import hashlib
import json
import os
import re
import urllib.request

import pandas as pd

from src.acquire.corpus import append_articles
from src.acquire.news import classify_topics, score_sentiment

HF_ARTICLES_REPO = "ashraq/financial-news-articles"
GDELT_NEWS_REPO = "openalphalab/gdelt-news"
GOLD_RE = re.compile(r"\b(gold|xauusd|precious metal|bullion)\b", re.IGNORECASE)
MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ["January", "February", "March", "April", "May", "June",
         "July", "August", "September", "October", "November", "December"]
    )
}


def _hf_url(fname: str) -> str:
    return f"https://huggingface.co/datasets/{HF_ARTICLES_REPO}/resolve/main/{fname}"


def _gdelt_url(path: str) -> str:
    return f"https://huggingface.co/datasets/{GDELT_NEWS_REPO}/resolve/main/{path}"


def _download(url: str, path: str, timeout: int = 600) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(path, "wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)


def _parse_hf_date(text: str):
    """Parse tanggal dari teks Reuters/CNBC (mis. 'January 2, 2018 / 9:31 PM')."""
    if not isinstance(text, str):
        return None
    m = re.match(r"([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})", text)
    if m and m.group(1) in MONTHS:
        try:
            return pd.Timestamp(int(m.group(3)), MONTHS[m.group(1)], int(m.group(2)))
        except ValueError:
            return None
    return None


def _to_article(title: str, body: str, url: str, ts, feed: str) -> dict | None:
    if not title or ts is None:
        return None
    score, label, method = score_sentiment(f"{title} {body}")
    article_id = feed.split(":")[0] + ":" + hashlib.sha1(f"{title}|{ts}".encode()).hexdigest()[:16]
    return {
        "id": article_id,
        "title": title,
        "summary": body or "",
        "time_published_utc": ts.strftime("%Y-%m-%d %H:%M:%S+00:00"),
        "overall_sentiment_score": score,
        "overall_sentiment_label": label,
        "topics": classify_topics(f"{title} {body}") or ["financial_markets"],
        "url": url or article_id,
        "source_feed": feed,
        "source_url": url,
        "publisher": "",
        "sentiment_method": method,
        "related_event": None,
    }


def fetch_hf_articles_body(
    corpus_path: str = "data/processed/news_corpus.jsonl",
    cache_dir: str = "data/raw/news/hf_articles_cache",
    max_shards: int = 2,
) -> int:
    """Ambil isi berita emas dari ashraq/financial-news-articles (2018)."""
    files = [
        "data/train-00000-of-00002-a3f58f0eb179f9ed.parquet",
        "data/train-00001-of-00002-50e0d6558d13575f.parquet",
    ][:max_shards]
    collected: list[dict] = []
    for fname in files:
        path = os.path.join(cache_dir, os.path.basename(fname))
        if not os.path.exists(path):
            print(f"[HFBody] Mengunduh {fname} (~240MB)...")
            _download(_hf_url(fname), path)
        df = pd.read_parquet(path)
        gold = df[df["title"].fillna("").str.contains(GOLD_RE)]
        for row in gold.itertuples():
            ts = _parse_hf_date(row.text)
            art = _to_article(row.title, row.text, row.url, ts, "hf_body")
            if art:
                collected.append(art)
        print(f"[HFBody] {fname}: {len(gold)} artikel emas (total {len(collected)})")

    if not collected:
        return 0
    added = append_articles(corpus_path, collected)
    print(f"[HFBody] +{added} artikel berisi baru di korpus.")
    return added


def fetch_gdelt_news_body(
    corpus_path: str = "data/processed/news_corpus.jsonl",
    cache_dir: str = "data/raw/news/gdelt_news_cache",
    files: list[str] | None = None,
) -> int:
    """Ambil isi berita emas dari openalphalab/gdelt-news (2020/2026)."""
    files = files or [
        "data/2020/01/01/20200101001800-20200101014600.parquet",
    ]
    collected: list[dict] = []
    for fpath in files:
        path = os.path.join(cache_dir, os.path.basename(fpath))
        if not os.path.exists(path):
            print(f"[GDELTBody] Mengunduh {fpath} (~36MB)...")
            _download(_gdelt_url(fpath), path)
        df = pd.read_parquet(path)
        df = df[df["language"] == "en"]
        gold = df[df["text"].fillna("").str.contains(GOLD_RE)]
        for row in gold.itertuples():
            ts = pd.to_datetime(row.date, utc=True)
            art = _to_article(row.text[:200], row.text, row.source_url, ts, "gdelt_body")
            if art:
                collected.append(art)
        print(f"[GDELTBody] {fpath}: {len(gold)} artikel emas (total {len(collected)})")

    if not collected:
        return 0
    added = append_articles(corpus_path, collected)
    print(f"[GDELTBody] +{added} artikel berisi baru di korpus.")
    return added


if __name__ == "__main__":
    fetch_hf_articles_body()
    fetch_gdelt_news_body()
