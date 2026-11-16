"""Diagnosa: kenapa IC baseline 0.99 dan delta negatif besar?"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "services" / "sentiment-analysis"))

OUT = "research/experiments/h1-embeddings"

df = pd.read_parquet(f"{OUT}/bucketed_with_emb.parquet")
print("shape:", df.shape)

# 1. cek korelasi fitur dengan target pada test
te = df[df["split"] == "test"]
print("\n[1] korelasi fitur vs ret_4h pada test (top 15):")
cors = {}
for c in te.columns:
    if te[c].dtype.kind in "fi":
        v = te[c]
        if v.nunique() > 1:
            cors[c] = abs(spearmanr(v, te["ret_4h"]).statistic)
for c, v in sorted(cors.items(), key=lambda x: -x[1])[:15]:
    print(f"  {c:35s} {v:.4f}")

# 2. cek apakah p_4h / p_24h membocorkan masa depan
print("\n[2] korelasi p_4h, p_24h dengan ret_4h (test):")
for c in ["p0", "p_4h", "p_24h", "vol_pre"]:
    if c in te.columns:
        print(f"  {c}: {spearmanr(te[c], te['ret_4h']).statistic:.4f}")

# 3. cek NaN di kolom embedding
emb_cols = [c for c in df.columns if c.startswith("emb_pc")]
print("\n[3] NaN embedding:", int(df[emb_cols].isna().sum().sum()))
print("    sebaran article_count di test:", dict(te["article_count"].value_counts().head()))

# 4. cek text_full: berapa banyak yang kosong
print("\n[4] text_full kosong:", int((df["text_full"].fillna("").str.strip() == "").sum()), "/", len(df))
print("    text_full kosong di test:", int((te["text_full"].fillna("").str.strip() == "").sum()), "/", len(te))
