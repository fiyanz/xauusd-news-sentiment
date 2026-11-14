"""Gold relevance: memisahkan berita yang benar-benar soal emas dari berita umum.

Temuan dari analisis dampak sentimen:
- Berita dengan topik `commodities` (emas) punya sinyal kuat (p=0,0005).
- Berita umum (`financial_markets`) tidak ada sinyal (p=0,557).
- Sinyal gold-specific stabil di semua kelompok volatilitas (low p=0,0;
  high p=0,0075), sedangkan sinyal "bukan gold" lebih besar hanya karena
  volatilitas saham lebih tinggi — bukan karena relevansi.

Modul ini menambahkan kolom `gold_relevance` (0..1) ke artikel:
- 1.0 → judul mengandung gold/xauusd/precious metal/bullion.
- 0.5 → judul mengandung kata penambang emas (gold fields, newmont, barrick, ...).
- 0.0 → lainnya.

Kolom ini dipakai untuk membobot fitur sentimen: berita yang relevan emas
diberi bobot penuh, berita umum dikurangi. Ini menjawab kekhawatiran "topik
yang dicampur jadi kacau".
"""

import re

import numpy as np
import pandas as pd

GOLD_RE = re.compile(r"\b(gold|xauusd|precious metal|bullion)\b", re.IGNORECASE)
GOLD_MINER_RE = re.compile(
    r"\b(gold fields|newmont|barrick|ag eagle|ag-miner|gold miner|gold mining|"
    r"gold producer|gold etf|gld|iau|sgol|sivr)\b",
    re.IGNORECASE,
)
# "Gold Fields" mengandung kata "gold" murni, jadi GOLD_RE juga cocok.
# Untuk membedakan penambang emas, cek pola penambang TERLEBIH DAHULU dengan
# mengecualikan judul yang hanya menyebut "gold" umum.
GOLD_MINER_ONLY_RE = re.compile(
    r"\b(gold fields|newmont|barrick|ag eagle|ag-miner|gold miner|gold mining|"
    r"gold producer|gold etf|gld|iau|sgol|sivr)\b",
    re.IGNORECASE,
)


def compute_gold_relevance(title: str) -> float:
    """1.0 = emas langsung, 0.5 = penambang/ETF emas, 0.0 = lainnya.

    "Gold Fields" (perusahaan penambang) dinilai 0.5, bukan 1.0, karena yang
    dibicarakan adalah saham penambang, bukan harga emas.
    """
    text = title or ""
    if GOLD_MINER_ONLY_RE.search(text):
        return 0.5
    if GOLD_RE.search(text):
        return 1.0
    return 0.0


def add_gold_relevance(df: pd.DataFrame, title_col: str = "title") -> pd.DataFrame:
    """Tambah kolom `gold_relevance` ke DataFrame artikel."""
    out = df.copy()
    out["gold_relevance"] = out[title_col].fillna("").apply(compute_gold_relevance).astype(float)
    return out


def apply_relevance_to_sentiment(
    df: pd.DataFrame,
    sentiment_col: str = "overall_sentiment_score",
    relevance_col: str = "gold_relevance",
    floor: float = 0.25,
) -> pd.DataFrame:
    """Kalikan skor sentimen dengan relevansi emas (dengan lantai `floor`).

    Berita yang relevan emas (1.0) → skor utuh.
    Berita penambang (0.5) → skor setengah.
    Berita umum (0.0) → skor dikali `floor` (tidak dibuang, tapi dikecilkan).
    """
    out = df.copy()
    w = out[relevance_col].fillna(0.0).clip(lower=floor)
    out[f"{sentiment_col}_weighted"] = out[sentiment_col].fillna(0.0) * w
    return out


def relevance_summary(df: pd.DataFrame) -> dict:
    """Ringkasan distribusi relevansi emas."""
    rel = df["gold_relevance"] if "gold_relevance" in df.columns else add_gold_relevance(df)["gold_relevance"]
    return {
        "n": int(len(df)),
        "gold_direct": int((rel == 1.0).sum()),
        "gold_miner": int((rel == 0.5).sum()),
        "not_gold": int((rel == 0.0).sum()),
        "mean_relevance": round(float(rel.mean()), 4),
    }
