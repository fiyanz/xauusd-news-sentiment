"""Uji multi-model klasifikasi dua-fase dengan fitur tambahan.

Model: Logistic Regression, SVM, XGBoost, Random Forest, LightGBM.
Fitur: sentimen, relevansi, waktu, volatilitas, surprise, makro (point-in-time).
Anti look-ahead: TIDAK memakai ret_1h/ret_4h/ret_24h sebagai fitur.
"""

import sys

sys.path.insert(0, ".")

import json

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

from src.models.phase_model import PhaseConfig, build_phase_dataset


def split_chronological(df, time_col, train=0.6, val=0.2):
    d = df.sort_values(time_col).reset_index(drop=True)
    n = len(d)
    n_tr = int(n * train)
    n_va = int(n * val)
    d["split"] = "test"
    d.loc[: n_tr - 1, "split"] = "train"
    d.loc[n_tr : n_tr + n_va - 1, "split"] = "val"
    return d


def build_features(d, bucket_df=None):
    """Fitur point-in-time (anti look-ahead)."""
    X = pd.DataFrame(index=d.index)
    X["sentiment"] = d["overall_sentiment_score"].fillna(0.0)
    X["sentiment_abs"] = X["sentiment"].abs()
    X["sentiment_sq"] = X["sentiment"] ** 2
    X["gold"] = d["gold"].astype(float)
    X["macro"] = d["macro"].astype(float)
    hour = pd.to_datetime(d["time_published_utc"], utc=True).dt.hour
    X["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    X["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    X["dow"] = pd.to_datetime(d["time_published_utc"], utc=True).dt.day_of_week
    X["vol_pre"] = d["vol_pre"].fillna(0.0)
    X["vol_log"] = np.log1p(X["vol_pre"])

    if bucket_df is not None:
        bt = bucket_df.set_index("time_bucket")
        tb = pd.to_datetime(d["time_published_utc"], utc=True).dt.floor("4h")
        for c in [
            "z_score",
            "surprise_val",
            "has_event",
            "surprise_age_hours",
            "macro_us10y_lag1d",
            "macro_dxy_lag1d",
            "macro_oil_lag1d",
        ]:
            if c in bt.columns:
                X[c] = tb.map(bt[c]).fillna(0.0)
    return X


def get_models():
    try:
        from xgboost import XGBClassifier

        xgb = XGBClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8, random_state=42,
            eval_metric="mlogloss", verbosity=0,
        )
    except Exception:
        xgb = None
    try:
        from lightgbm import LGBMClassifier

        lgbm = LGBMClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8, random_state=42, verbose=-1,
        )
    except Exception:
        lgbm = None

    return {
        "LogisticRegression": LogisticRegression(max_iter=3000, class_weight="balanced", random_state=42),
        "SVM": SVC(kernel="rbf", probability=True, class_weight="balanced", random_state=42),
        "XGBoost": xgb,
        "RandomForest": RandomForestClassifier(
            n_estimators=200, max_depth=6, min_samples_leaf=20,
            class_weight="balanced", random_state=42, n_jobs=-1,
        ),
        "LightGBM": lgbm,
    }


def evaluate(name, d, bucket_df=None, seed=42):
    d = split_chronological(d, "time_published_utc")
    X = build_features(d, bucket_df)
    y = d["label3"].values
    tr = d["split"] == "train"
    te = d["split"] == "test"
    sc = StandardScaler().fit(X[tr])
    Xtr = sc.transform(X[tr])
    Xte = sc.transform(X[te])

    maj = pd.Series(y[te]).value_counts().idxmax()
    acc_base = float(accuracy_score(y[te], np.full_like(y[te], maj)))

    out = {"n_test": int(te.sum()), "baseline": round(acc_base, 4), "models": {}}
    rng = np.random.default_rng(seed)
    yt = y[te]

    for mname, model in get_models().items():
        if model is None:
            out["models"][mname] = {"error": "library tidak tersedia"}
            continue
        try:
            model.fit(Xtr, y[tr])
            pred = model.predict(Xte)
        except Exception as exc:  # noqa: BLE001
            out["models"][mname] = {"error": f"{type(exc).__name__}: {exc}"}
            continue
        acc = float(accuracy_score(yt, pred))
        diffs = []
        for _ in range(500):
            idx = rng.integers(0, len(yt), len(yt))
            diffs.append(
                accuracy_score(yt[idx], pred[idx])
                - accuracy_score(yt[idx], np.full_like(yt[idx], maj))
            )
        p = float(np.mean(np.asarray(diffs) <= 0))
        out["models"][mname] = {
            "accuracy": round(acc, 4),
            "delta": round(acc - acc_base, 4),
            "f1_macro": round(float(f1_score(yt, pred, average="macro", zero_division=0)), 4),
            "p_value": round(p, 4),
            "beats": bool(acc > acc_base and p < 0.05),
        }
    return out


def main():
    df = pd.read_parquet("data/processed/dataset_article.parquet")
    df = df.dropna(subset=["ret_4h"]).copy()

    cal = pd.read_csv("data/raw/calendar/economic_calendar_enriched.csv")
    real = cal[~cal["is_simulated"]].dropna(subset=["surprise_val"])

    ds = build_phase_dataset(df, real, PhaseConfig(window_hours=72, threshold_k=0.5))
    ds.to_parquet("data/processed/phase_dataset.parquet", index=False)
    bucket = pd.read_parquet("data/processed/bucketed_features.parquet")

    results = {}
    for ph, label in [("pra", "A_pra_event"), ("pasca", "B_pasca_event")]:
        sub = ds[ds["phase"] == ph].copy()
        results[label] = evaluate(label, sub, bucket)

    results["all_news"] = evaluate("all_news", ds, bucket)

    with open("reports/phase_model_multi.json", "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(json.dumps(results, indent=2, default=str))
    return results


if __name__ == "__main__":
    main()
