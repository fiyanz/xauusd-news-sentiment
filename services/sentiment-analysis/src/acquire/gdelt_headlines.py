"""GDELT News Headlines 2022 (keyless) sebagai sumber berita tambahan.

Dataset `MaxLong/gdelt-news-headlines-2022` menyediakan headline berita global
per bulan (2022) dengan kolom `article_date`, `url`, `title`. Ini mengisi
periode 2022 yang belum terjangkau RSS (~14 hari) maupun HuggingFace
ashraq/financial-news (2010-2020).

Kualitas: headline global (bukan khusus finansial), jadi hanya artikel yang
judulnya mengandung kata emas yang diambil. Dataset ini juga punya duplikasi
(baris sama berulang), jadi dedupe per (article_date, title) dilakukan.
"""

import hashlib
import json
import os
import re
import urllib.request

from src.acquire.corpus import append_articles
from src.acquire.news import classify_topics, score_sentiment

HF_REPO = "MaxLong/gdelt-news-headlines-2022"
GOLD_RE = re.compile(r"\b(gold|xauusd|precious metal|bullion)\b", re.IGNORECASE)
MONTHS_2022 = [f"2022{m:02d}" for m in range(1, 13)]


def _month_url(month: str) -> str:
    return f"https://huggingface.co/datasets/{HF_REPO}/resolve/main/{month}.jsonl"


def _to_article(item: dict, feed_label: str = "gdelt_headlines_2022") -> dict | None:
    title = (item.get("title") or "").strip()
    date = item.get("article_date")
    url = item.get("url") or ""
    if not title or not date:
        return None
    # article_date format: YYYYMMDD
    if not re.fullmatch(r"\d{8}", str(date)):
        return None
    try:
        ts = f"{str(date)[:4]}-{str(date)[4:6]}-{str(date)[6:8]} 12:00:00+00:00"
    except Exception:
        return None
    score, label, method = score_sentiment(title)
    article_id = "g22:" + hashlib.sha1(f"{date}|{title}".encode("utf-8")).hexdigest()[:16]
    return {
        "id": article_id,
        "title": title,
        "summary": "",
        "time_published_utc": ts,
        "overall_sentiment_score": score,
        "overall_sentiment_label": label,
        "topics": classify_topics(title) or ["financial_markets"],
        "url": url or article_id,
        "source_feed": feed_label,
        "source_url": url,
        "publisher": "",
        "sentiment_method": method,
        "related_event": None,
    }


def fetch_gdelt_headlines_2022(
    corpus_path: str = "data/processed/news_corpus.jsonl",
    months: list[str] | None = None,
    max_rows_per_month: int | None = None,
) -> int:
    """Unduh headline emas 2022 dan tambahkan ke korpus.

    Returns jumlah artikel baru yang benar-benar masuk (setelah dedupe).
    """
    months = months or MONTHS_2022
    collected: list[dict] = []
    seen: set[tuple] = set()

    for month in months:
        url = _month_url(month)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            resp = urllib.request.urlopen(req, timeout=180)
        except Exception as exc:  # noqa: BLE001 - jaringan; lanjut bulan lain
            print(f"[GDELT2022] {month} gagal: {type(exc).__name__}: {exc}")
            continue

        n_rows = 0
        n_gold = 0
        with resp:
            for raw in resp:
                n_rows += 1
                if max_rows_per_month and n_rows > max_rows_per_month:
                    break
                try:
                    item = json.loads(raw)
                except Exception:
                    continue
                title = (item.get("title") or "").strip()
                if not GOLD_RE.search(title):
                    continue
                key = (item.get("article_date"), title)
                if key in seen:
                    continue
                seen.add(key)
                art = _to_article(item)
                if art:
                    collected.append(art)
                    n_gold += 1
        print(f"[GDELT2022] {month}: rows={n_rows} gold_unique={n_gold} (total {len(collected)})")

    if not collected:
        print("[GDELT2022] tidak ada artikel emas baru.")
        return 0
    added = append_articles(corpus_path, collected)
    print(f"[GDELT2022] +{added} artikel emas 2022 baru di korpus (total {len(collected)} dikumpulkan).")
    return added


if __name__ == "__main__":
    fetch_gdelt_headlines_2022()
