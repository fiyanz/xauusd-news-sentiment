"""Evaluasi H1 lanjutan: split out-of-time murni + bucket berita saja.

Tujuan: memisahkan dua pertanyaan yang berbeda.
- A: apakah embedding berguna untuk prediksi umum (chronological)?
- B: apakah embedding berguna saat ada berita (news_era, bucket article_count>0)?
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "sentiment-analysis"))

OUT = "research/experiments/h1-embeddings"
BASELINE_COLS = [
    "z_score", "surprise_val", "surprise_age_hours", "has_event",
    "session_Asia", "session_London", "session_NewYork",
    "sentiment_score", "sentiment_min", "sentiment_max",
    "overall_sentiment_score", "article_count",
    "sentiment_x_surprise_pos", "sentiment_x_surprise_neg",
    "hour_sin", "hour_cos", "dow_sin", "dow_cos",
    "macro_pc1", "macro_pc2", "macro_pc3",
]
TARGET = "ret_4h"


def prepare(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    h = df["hour_utc"].astype(float)
    df["hour_sin"] = np.sin(2 * np.pi * h / 24)
    df["hour_cos"] = np.cos(2 * np.pi * h / 24)
    d = df["dayofweek"].astype(float)
    df["dow_sin"] = np.sin(2 * np.pi * d / 7)
    df["dow_cos"] = np.cos(2 * np.pi * d / 7)
    macro_cols = [c for c in df.columns if c.startswith("macro_") and c.endswith(("lag1d", "delta1d", "delta5d"))]
    from sklearn.decomposition import PCA
    tr = (df["split"] == "train").values
    X = df[macro_cols].fillna(0).values
    sc = StandardScaler().fit(X[tr])
    pca = PCA(n_components=3, random_state=42).fit(sc.transform(X[tr]))
    red = pca.transform(sc.transform(X))
    for i in range(3):
        df[f"macro_pc{i + 1}"] = red[:, i]
    return df


def rank_ic(y, p):
    from scipy.stats import spearmanr
    if len(np.unique(y)) < 2 or len(np.unique(p)) < 2:
        return 0.0
    ic, _ = spearmanr(y, p)
    return float(ic) if np.isfinite(ic) else 0.0


def paired_bootstrap(y, full, base, n=1000, seed=42):
    rng = np.random.default_rng(seed)
    d = np.empty(n)
    for i in range(n):
        idx = rng.integers(0, len(y), len(y))
        d[i] = rank_ic(y[idx], full[idx]) - rank_ic(y[idx], base[idx])
    return {
        "delta_mean": float(d.mean()),
        "ci95": [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))],
        "p_value": float((np.sum(d <= 0) + 1) / (n + 1)),
        "prob_full_better": float((d > 0).mean()),
    }


def run(df, tr_mask, te_mask, label):
    cols = [c for c in BASELINE_COLS if c in df.columns]
    emb = [c for c in df.columns if c.startswith("emb_pc")]
    Xtr = df.loc[tr_mask, cols].fillna(0).values
    Xte = df.loc[te_mask, cols].fillna(0).values
    ytr = df.loc[tr_mask, TARGET].values
    yte = df.loc[te_mask, TARGET].values
    sc = StandardScaler().fit(Xtr)
    m = Ridge(alpha=1.0).fit(sc.transform(Xtr), ytr)
    base_pred = m.predict(sc.transform(Xte))

    Xtr2 = np.hstack([Xtr, df.loc[tr_mask, emb].fillna(0).values])
    Xte2 = np.hstack([Xte, df.loc[te_mask, emb].fillna(0).values])
    sc2 = StandardScaler().fit(Xtr2)
    m2 = Ridge(alpha=1.0).fit(sc2.transform(Xtr2), ytr)
    full_pred = m2.predict(sc2.transform(Xte2))

    b_ic, f_ic = rank_ic(yte, base_pred), rank_ic(yte, full_pred)
    boot = paired_bootstrap(yte, full_pred, base_pred)
    print(f"[{label}] n={len(yte)} base={b_ic:.4f} full={f_ic:.4f} "
          f"delta={f_ic-b_ic:+.4f} p={boot['p_value']:.4f} adds={boot['delta_mean']>0 and boot['p_value']<0.05}")
    return {"label": label, "n": int(len(yte)), "baseline_ic": round(b_ic, 6),
            "full_ic": round(f_ic, 6), "delta": round(f_ic - b_ic, 6),
            "bootstrap": {k: (round(v, 6) if isinstance(v, float) else v) for k, v in boot.items()}}


def main():
    df = prepare(pd.read_parquet(f"{OUT}/bucketed_with_emb.parquet"))
    tr = df["split"] == "train"

    results = {}
    # A: chronological (test bawaan)
    results["chronological"] = run(df, tr, df["split"] == "test", "chronological")

    # B: news_era — test = bucket berita, train = bucket non-berita (out-of-time)
    has_art = df["article_count"] > 0
    results["news_only_test"] = run(df, tr, has_art, "news_only_test")

    # C: split murni out-of-time (val+test), train saja
    oot = df["split"].isin(["val", "test"])
    results["out_of_time"] = run(df, tr, oot, "out_of_time")

    with open(f"{OUT}/results_v2.json", "w") as f:
        json.dump(results, f, indent=2)
    print(f"\ntersimpan: {OUT}/results_v2.json")


if __name__ == "__main__":
    main()
