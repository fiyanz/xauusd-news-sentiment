"""Loughran-McDonald financial sentiment lexicon.

VADER is a general-purpose lexicon; it misses finance-specific polarity (e.g.
"liability", "write-down", "outperform"). The Loughran-McDonald Master
Dictionary is hand-tagged for financial text and is the standard alternative
used in accounting/finance research (Loughran & McDonald 2011).

The dictionary is free for academic research. The CSV is downloaded once and
cached; no API key.
"""

import csv
import os
import re
import urllib.request

LM_CSV_URL = (
    "https://raw.githubusercontent.com/bthapa94/Test_Sentiment/main/"
    "Loughran-McDonald_MasterDictionary_1993-2025.csv"
)
DEFAULT_CACHE = "data/raw/news/loughran_mcdonald.csv"

_TOKEN_RE = re.compile(r"[a-z]+")


def _download(url: str, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=300) as resp, open(path, "wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)


class LoughranMcDonaldScorer:
    """Bag-of-words polarity using the Loughran-McDonald word lists."""

    def __init__(self, csv_path: str = DEFAULT_CACHE, force: bool = False):
        if force or not os.path.exists(csv_path):
            print(f"[LM] Downloading {LM_CSV_URL} (sekali, ~8.5MB)...")
            _download(LM_CSV_URL, csv_path)
        self.positive: set[str] = set()
        self.negative: set[str] = set()
        self.uncertainty: set[str] = set()
        self.litigious: set[str] = set()
        with open(csv_path, "r", encoding="utf-8", errors="replace") as f:
            reader = csv.DictReader(f)
            for row in reader:
                word = (row.get("Word") or "").strip().lower()
                if not word:
                    continue
                try:
                    if int(float(row.get("Positive") or 0)) > 0:
                        self.positive.add(word)
                    if int(float(row.get("Negative") or 0)) > 0:
                        self.negative.add(word)
                    if int(float(row.get("Uncertainty") or 0)) > 0:
                        self.uncertainty.add(word)
                    if int(float(row.get("Litigious") or 0)) > 0:
                        self.litigious.add(word)
                except (TypeError, ValueError):
                    continue
        print(f"[LM] Dictionary loaded: +{len(self.positive)} / -{len(self.negative)} / "
              f"uncertainty {len(self.uncertainty)} / litigious {len(self.litigious)}")

    def score(self, text: str) -> dict:
        """Return LM polarity and category ratios for one text."""
        tokens = _TOKEN_RE.findall((text or "").lower())
        total = len(tokens) or 1
        pos = sum(1 for t in tokens if t in self.positive)
        neg = sum(1 for t in tokens if t in self.negative)
        unc = sum(1 for t in tokens if t in self.uncertainty)
        lit = sum(1 for t in tokens if t in self.litigious)
        polarity = (pos - neg) / max(pos + neg, 1)
        return {
            "sentiment_lm": round(float(polarity), 4),
            "lm_polarity": round(float(polarity), 4),
            "lm_positive_ratio": round(pos / total, 4),
            "lm_negative_ratio": round(neg / total, 4),
            "lm_uncertainty_ratio": round(unc / total, 4),
            "lm_litigious_ratio": round(lit / total, 4),
            "lm_hits": int(pos + neg),
        }


def rescore_corpus_with_lm(corpus_path: str = "data/processed/news_corpus.jsonl") -> int:
    """Add Loughran-McDonald scores to articles that lack them.

    VADER stays available; the lexicon score is stored alongside so the two can
    be compared without re-acquiring the news. Returns the number updated.
    """
    from src.acquire.corpus import load_corpus, write_corpus

    articles = load_corpus(corpus_path)
    if not articles:
        print("[LM] korpus kosong; tidak ada yang di-rescore.")
        return 0
    scorer = LoughranMcDonaldScorer()
    updated = 0
    for a in articles:
        scores = scorer.score(f"{a.get('title', '')} {a.get('summary', '')}")
        a.update(scores)
        updated += 1
    if updated:
        write_corpus(corpus_path, articles)
    print(f"[LM] {updated} artikel di-rescore dengan Loughran-McDonald.")
    return updated


if __name__ == "__main__":
    scorer = LoughranMcDonaldScorer()
    for text in [
        "Gold prices surge as investors seek safe haven amid rising inflation",
        "The company reported a large write-down and falling revenue",
        "Markets were flat in quiet trading",
    ]:
        print(scorer.score(text), "|", text)
