"""Preprocessing teks: stemming + stop words + TF-IDF.

Memperkaya representasi teks dari judul/isi berita:
- Tokenisasi, lowercasing, hapus angka/tanda baca.
- Stop words (Bahasa Inggris) + stop words khusus keuangan yang terlalu umum.
- Stemming (Porter) supaya "rates", "rate", "rating" jadi satu akar.
- TF-IDF dengan n-gram (1,2) dan vocab terbatas.

Catatan: stemming dipakai karena embedding multibahasa tidak tersedia secara
keyless; TF-IDF + stemming adalah alternatif ringan yang bisa dijalankan lokal.
"""

import re

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer

try:
    from nltk.stem import PorterStemmer

    _STEMMER = PorterStemmer()
except Exception:  # pragma: no cover
    _STEMMER = None

_TOKEN_RE = re.compile(r"[a-z]+")

# Stop words tambahan: kata keuangan yang terlalu umum untuk membedakan berita.
EXTRA_STOPWORDS = {
    "gold", "silver", "oil", "price", "prices", "market", "markets",
    "said", "say", "says", "new", "year", "week", "day", "time",
    "percent", "rose", "fell", "rise", "fall", "up", "down",
}


def stem_tokens(text: str) -> list[str]:
    """Tokenisasi + stemming sederhana."""
    tokens = _TOKEN_RE.findall((text or "").lower())
    if _STEMMER is None:
        return tokens
    return [_STEMMER.stem(t) for t in tokens]


def preprocess_text(text: str) -> str:
    """Gabungkan token yang sudah di-stem menjadi string."""
    return " ".join(stem_tokens(text))


def build_tfidf(
    texts: list[str],
    max_features: int = 300,
    ngram_range: tuple[int, int] = (1, 2),
    min_df: int = 2,
) -> tuple[TfidfVectorizer, np.ndarray]:
    """Fit TF-IDF pada teks ter-preprocess."""
    processed = [preprocess_text(t) for t in texts]
    vec = TfidfVectorizer(
        max_features=max_features,
        ngram_range=ngram_range,
        min_df=min_df,
        stop_words="english",
    )
    mat = vec.fit_transform(processed)
    return vec, mat


def transform_tfidf(vec: TfidfVectorizer, texts: list[str]) -> np.ndarray:
    processed = [preprocess_text(t) for t in texts]
    return vec.transform(processed).toarray()


def text_for_row(row: pd.Series) -> str:
    """Gabungkan judul + isi (bila ada) untuk satu artikel."""
    title = row.get("title") or ""
    body = row.get("summary") or ""
    return f"{title} {body}".strip()
