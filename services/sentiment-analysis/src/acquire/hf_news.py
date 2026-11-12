"""HuggingFace financial news (keyless) as a historical news source.

``ashraq/financial-news`` provides ~1.85M financial headlines with a clean
``date`` column (2010-2020). RSS only exposes ~14 days, so the sentiment features
have no training coverage. This module keeps only gold-related headlines
(~33k) and appends them to the same persistent corpus, giving the sentiment
features real history to learn from.

The dataset is a static snapshot: no API key, no rate limit. The full parquet is
downloaded once and the filtered subset is cached; the raw file is removed.
"""

import hashlib
import os
import re
import urllib.request

import pandas as pd

from src.acquire.corpus import append_articles
from src.acquire.news import classify_topics, score_sentiment

HF_DATASET_PARQUET = (
    "https://huggingface.co/datasets/ashraq/financial-news/resolve/main/"
    "data/train-00000-of-00001-8ec327f23bbe0948.parquet"
)
GOLD_RE = re.compile(r"\b(gold|xauusd|precious metal)", re.IGNORECASE)
GOLD_EXCLUDE_RE = re.compile(r"goldman|golden", re.IGNORECASE)
DEFAULT_CACHE = "data/raw/news/hf_gold_news.parquet"
NEUTRAL_HOUR_UTC = 12  # waktu pasti tidak tersedia; tengah hari sebagai nilai netral


def _download(url: str, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=600) as resp, open(path, "wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)


def load_gold_headlines(cache_path: str = DEFAULT_CACHE, force: bool = False) -> pd.DataFrame:
    """Load gold-related headlines, downloading + filtering the dataset once."""
    if os.path.exists(cache_path) and not force:
        return pd.read_parquet(cache_path)

    full_path = cache_path + ".full.parquet"
    if not os.path.exists(full_path):
        print(f"[HFNews] Downloading {HF_DATASET_PARQUET} (sekali, ~142MB)...")
        _download(HF_DATASET_PARQUET, full_path)

    df = pd.read_parquet(full_path)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    hl = df["headline"].fillna("").astype(str)
    mask = hl.str.contains(GOLD_RE) & ~hl.str.contains(GOLD_EXCLUDE_RE)
    gold = df[mask].dropna(subset=["date"]).sort_values("date").reset_index(drop=True)
    gold.to_parquet(cache_path, index=False)
    print(f"[HFNews] {len(gold)} gold-related headlines cached to {cache_path}.")

    # The raw 142MB file is no longer needed once filtered.
    try:
        os.remove(full_path)
    except OSError:
        pass
    return gold


def fetch_hf_gold_news(
    corpus_path: str = "data/processed/news_corpus.jsonl",
    cache_path: str = DEFAULT_CACHE,
) -> int:
    """Append gold-related HF headlines to the corpus; return new rows."""
    gold = load_gold_headlines(cache_path)
    if gold.empty:
        print("[HFNews] tidak ada headline emas.")
        return 0

    articles: list[dict] = []
    for row in gold.itertuples():
        title = str(row.headline)
        published = row.date
        ts = published.normalize() + pd.Timedelta(hours=NEUTRAL_HOUR_UTC)
        score, label, method = score_sentiment(title)
        url = str(row.url) if row.url else ""
        article_id = "hf:" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:16]
        articles.append(
            {
                "id": article_id,
                "title": title,
                "summary": "",
                "time_published_utc": ts.strftime("%Y-%m-%d %H:%M:%S+00:00"),
                "overall_sentiment_score": score,
                "overall_sentiment_label": label,
                "topics": classify_topics(title) or ["financial_markets"],
                "url": url or article_id,
                "source_feed": "hf_financial_news",
                "source_url": url,
                "publisher": str(row.publisher) if row.publisher else "",
                "sentiment_method": method,
                "related_event": None,
            }
        )

    added = append_articles(corpus_path, articles)
    print(
        f"[HFNews] +{added} artikel emas baru di korpus "
        f"(total {len(articles)} headline emas, {gold['date'].min().date()} .. {gold['date'].max().date()})."
    )
    return added


if __name__ == "__main__":
    fetch_hf_gold_news()
