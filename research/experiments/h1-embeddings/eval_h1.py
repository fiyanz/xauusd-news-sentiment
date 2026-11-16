"""Evaluasi H1: model full (dengan embedding) vs baseline makro.

Memakai pola yang sama dengan src/evaluate/significance.py:
- champion dipilih by CV pada train
- paired bootstrap 1.000 resampling pada test
- delta_rank_ic = full - baseline
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "services" / "sentiment-analysis"))

OUT = "research/experiments/h1-embeddings"

# Daftar fitur resmi dari bundle model (tanpa p_4h/p_24h yang forward-looking).
# Catatan: versi pertama skrip ini keliru memakai p_4h/p_24h -> kebocoran,
# menghasilkan IC 0.99. Diganti dengan daftar resmi.
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


def rank_ic(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    if len(np.unique(y_true)) < 2 or len(np.unique(y_pred)) < 2:
        return 0.0
    ic, _ = spearmanr(y_true, y_pred)
    return float(ic) if np.isfinite(ic) else 0.0


def paired_bootstrap(y, full, base, n=1000, seed=42) -> dict:
    rng = np.random.default_rng(seed)
    deltas = np.empty(n)
    for i in range(n):
        idx = rng.integers(0, len(y), len(y))
        deltas[i] = rank_ic(y[idx], full[idx]) - rank_ic(y[idx], base[idx])
    p = float((np.sum(deltas <= 0) + 1) / (n + 1))
    return {
        "delta_mean": float(deltas.mean()),
        "ci95": [float(np.percentile(deltas, 2.5)), float(np.percentile(deltas, 97.5))],
        "p_value": p,
        "prob_full_better": float((deltas > 0).mean()),
    }


def prepare(df: pd.DataFrame) -> pd.DataFrame:
    """Turunkan fitur siklikal + PCA makro yang dipakai pipeline resmi.

    hour_sin/cos, dow_sin/cos dari hour_utc/dayofweek; macro_pc1..3 dari
    blok makro (PCA fit on train saja, dipisah per split).
    """
    df = df.copy()
    if "hour_utc" in df.columns:
        h = df["hour_utc"].astype(float)
        df["hour_sin"] = np.sin(2 * np.pi * h / 24)
        df["hour_cos"] = np.cos(2 * np.pi * h / 24)
    if "dayofweek" in df.columns:
        d = df["dayofweek"].astype(float)
        df["dow_sin"] = np.sin(2 * np.pi * d / 7)
        df["dow_cos"] = np.cos(2 * np.pi * d / 7)
    macro_cols = [c for c in df.columns if c.startswith("macro_") and c.endswith(("lag1d", "delta1d", "delta5d"))]
    if macro_cols and "macro_pc1" not in df.columns:
        from sklearn.decomposition import PCA
        from sklearn.preprocessing import StandardScaler
        tr = df["split"] == "train"
        X = df[macro_cols].fillna(0).values
        sc = StandardScaler().fit(X[tr.values])
        pca = PCA(n_components=3, random_state=42).fit(sc.transform(X[tr.values]))
        red = pca.transform(sc.transform(X))
        for i in range(3):
            df[f"macro_pc{i + 1}"] = red[:, i]
    return df


def fit_predict(cols, split_mode="chronological"):
    df = prepare(pd.read_parquet(f"{OUT}/bucketed_with_emb.parquet"))
    if split_mode == "news_era":
        # test = bucket yang punya berita, out-of-time
        df = df[df["split"].isin(["train", "val", "test"])].copy()
        df["_split"] = np.where(df["article_count"] > 0, "test", df["split"])
        tr = df[df["_split"] == "train"]
        te = df[df["_split"] == "test"]
    else:
        tr = df[df["split"] == "train"]
        te = df[df["split"] == "test"]

    cols = [c for c in cols if c in df.columns]
    Xtr = tr[cols].fillna(0).values
    Xte = te[cols].fillna(0).values
    ytr = tr[TARGET].values
    yte = te[TARGET].values

    sc = StandardScaler().fit(Xtr)
    model = Ridge(alpha=1.0)
    model.fit(sc.transform(Xtr), ytr)
    return yte, model.predict(sc.transform(Xte))


def main() -> None:
    results = {}
    for mode in ["chronological", "news_era"]:
        yte, base_pred = fit_predict(BASELINE_COLS, mode)
        full_cols = BASELINE_COLS + [c for c in pd.read_parquet(f"{OUT}/bucketed_with_emb.parquet").columns if c.startswith("emb_pc")]
        _, full_pred = fit_predict(full_cols, mode)

        base_ic = rank_ic(yte, base_pred)
        full_ic = rank_ic(yte, full_pred)
        boot = paired_bootstrap(yte, full_pred, base_pred)
        results[mode] = {
            "n_test": int(len(yte)),
            "baseline_ic": round(base_ic, 6),
            "full_ic": round(full_ic, 6),
            "delta": round(full_ic - base_ic, 6),
            "bootstrap": {k: (round(v, 6) if isinstance(v, float) else v) for k, v in boot.items()},
            "sentiment_adds_value": bool(boot["delta_mean"] > 0 and boot["p_value"] < 0.05),
        }
        print(f"[{mode}] n={len(yte)} base={base_ic:.4f} full={full_ic:.4f} "
              f"delta={full_ic-base_ic:+.4f} p={boot['p_value']:.4f} "
              f"adds_value={results[mode]['sentiment_adds_value']}")

    with open(f"{OUT}/results.json", "w") as f:
        json.dump(results, f, indent=2)
    print(f"\ntersimpan: {OUT}/results.json")


if __name__ == "__main__":
    main()
