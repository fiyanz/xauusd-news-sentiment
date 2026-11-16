"""Evaluasi H2: judul saja vs judul+isi."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.decomposition import PCA
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "services" / "sentiment-analysis"))

OUT = "research/experiments/h2-body"
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
    tr = (df["split"] == "train").values
    X = df[macro_cols].fillna(0).values
    sc = StandardScaler().fit(X[tr])
    pca = PCA(n_components=3, random_state=42).fit(sc.transform(X[tr]))
    red = pca.transform(sc.transform(X))
    for i in range(3):
        df[f"macro_pc{i + 1}"] = red[:, i]
    return df


def rank_ic(y, p):
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


def predict(df, tr_mask, te_mask, cols):
    cols = [c for c in cols if c in df.columns]
    Xtr = df.loc[tr_mask, cols].fillna(0).values
    Xte = df.loc[te_mask, cols].fillna(0).values
    ytr = df.loc[tr_mask, TARGET].values
    sc = StandardScaler().fit(Xtr)
    m = Ridge(alpha=1.0).fit(sc.transform(Xtr), ytr)
    return df.loc[te_mask, TARGET].values, m.predict(sc.transform(Xte))


def main():
    df = prepare(pd.read_parquet(f"{OUT}/bucketed_title_body.parquet"))
    tr = df["split"] == "train"
    te = df["article_count"] > 0  # bucket berita

    base_cols = BASELINE_COLS
    title_cols = base_cols + [c for c in df.columns if c.startswith("title_emb_pc")]
    body_cols = base_cols + [c for c in df.columns if c.startswith("body_emb_pc")]

    yte, base_pred = predict(df, tr, te, base_cols)
    _, title_pred = predict(df, tr, te, title_cols)
    _, body_pred = predict(df, tr, te, body_cols)

    res = {"n_test": int(te.sum())}
    for name, pred in [("baseline", base_pred), ("title", title_pred), ("body", body_pred)]:
        ic = rank_ic(yte, pred)
        boot = paired_bootstrap(yte, pred, base_pred)
        res[name] = {"ic": round(ic, 6), "delta_vs_baseline": round(ic - rank_ic(yte, base_pred), 6),
                     "bootstrap": {k: (round(v, 6) if isinstance(v, float) else v) for k, v in boot.items()}}
        print(f"[{name}] IC={ic:.4f} delta={ic-rank_ic(yte,base_pred):+.4f} p={boot['p_value']:.4f}")

    # bandingkan title vs body langsung
    boot_tb = paired_bootstrap(yte, body_pred, title_pred)
    res["body_vs_title"] = {k: (round(v, 6) if isinstance(v, float) else v) for k, v in boot_tb.items()}
    print(f"[body vs title] delta={boot_tb['delta_mean']:+.4f} p={boot_tb['p_value']:.4f}")

    with open(f"{OUT}/results.json", "w") as f:
        json.dump(res, f, indent=2)
    print(f"\ntersimpan: {OUT}/results.json")


if __name__ == "__main__":
    main()
