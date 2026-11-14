"""Uji model dua-fase: apakah berita makro punya daya prediksi?

Dua model:
- Model A (pra-event): prediksi label dari berita sebelum rilis.
- Model B (pasca-event): prediksi label dari berita sesudah rilis.

Metode jujur:
- Baseline: tebak kelas mayoritas (tanpa fitur).
- Evaluasi: akurasi, F1 macro, dan uji apakah model mengungguli baseline
  (bootstrap pada selisih akurasi).
- Split chronological: train 60% / val 20% / test 20% berdasarkan waktu.
"""

import sys

sys.path.insert(0, ".")

import json

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score
from sklearn.preprocessing import StandardScaler

from src.models.phase_model import PhaseConfig, build_phase_dataset


def split_chronological(df: pd.DataFrame, time_col: str, train=0.6, val=0.2):
    d = df.sort_values(time_col).reset_index(drop=True)
    n = len(d)
    n_tr = int(n * train)
    n_va = int(n * val)
    d["split"] = "test"
    d.loc[: n_tr - 1, "split"] = "train"
    d.loc[n_tr : n_tr + n_va - 1, "split"] = "val"
    return d


def features(d: pd.DataFrame) -> pd.DataFrame:
    """Fitur point-in-time (anti look-ahead).

    PERHATIAN: jangan memakai ret_1h/ret_4h/ret_24h atau turunannya sebagai
    fitur — itu informasi masa depan yang bocor (sebelumnya sempat menaikkan
    akurasi palsu ke 0,79). Fitur yang dipakai hanya yang tersedia saat
    berita terbit.
    """
    X = pd.DataFrame(index=d.index)
    X["sentiment"] = d["overall_sentiment_score"].fillna(0.0)
    X["sentiment_abs"] = X["sentiment"].abs()
    X["gold"] = d["gold"].astype(float)
    X["macro"] = d["macro"].astype(float)
    X["hour"] = pd.to_datetime(d["time_published_utc"], utc=True).dt.hour
    X["hour_sin"] = np.sin(2 * np.pi * X["hour"] / 24)
    X["hour_cos"] = np.cos(2 * np.pi * X["hour"] / 24)
    X["vol_pre"] = d["vol_pre"].fillna(0.0)
    return X


def evaluate(name: str, d: pd.DataFrame, seed: int = 42) -> dict:
    d = split_chronological(d, "time_published_utc")
    X = features(d)
    y = d["label3"].values

    tr = d["split"] == "train"
    va = d["split"] == "val"
    te = d["split"] == "test"

    sc = StandardScaler().fit(X[tr])
    clf = LogisticRegression(max_iter=2000, class_weight="balanced", random_state=seed)
    clf.fit(sc.transform(X[tr]), y[tr])

    pred_te = clf.predict(sc.transform(X[te]))
    acc = float(accuracy_score(y[te], pred_te))
    f1 = float(f1_score(y[te], pred_te, average="macro", zero_division=0))

    # baseline mayoritas
    maj = pd.Series(y[te]).value_counts().idxmax()
    acc_base = float(accuracy_score(y[te], np.full_like(y[te], maj)))

    # bootstrap: apakah model > baseline?
    rng = np.random.default_rng(seed)
    diffs = []
    yt = y[te]
    for _ in range(1000):
        idx = rng.integers(0, len(yt), len(yt))
        a_m = accuracy_score(yt[idx], pred_te[idx])
        a_b = accuracy_score(yt[idx], np.full_like(yt[idx], maj))
        diffs.append(a_m - a_b)
    diffs = np.asarray(diffs)
    p_value = float(np.mean(diffs <= 0))

    return {
        "model": name,
        "n_train": int(tr.sum()),
        "n_test": int(te.sum()),
        "test_label_dist": pd.Series(y[te]).value_counts().to_dict(),
        "accuracy": round(acc, 4),
        "baseline_accuracy": round(acc_base, 4),
        "f1_macro": round(f1, 4),
        "delta_accuracy": round(acc - acc_base, 4),
        "p_value": round(p_value, 4),
        "beats_baseline": bool(acc > acc_base and p_value < 0.05),
    }


def main():
    df = pd.read_parquet("data/processed/dataset_article.parquet")
    df = df.dropna(subset=["ret_4h"]).copy()

    cal = pd.read_csv("data/raw/calendar/economic_calendar_enriched.csv")
    real = cal[~cal["is_simulated"]].dropna(subset=["surprise_val"])

    ds = build_phase_dataset(df, real, PhaseConfig(window_hours=72, threshold_k=0.5))
    ds.to_parquet("data/processed/phase_dataset.parquet", index=False)

    results = {}
    for ph, label in [("pra", "A_pra_event"), ("pasca", "B_pasca_event")]:
        sub = ds[ds["phase"] == ph].copy()
        results[ph] = evaluate(label, sub)

    # baseline: semua berita (tanpa fase)
    results["all"] = evaluate("all_news", ds)

    # 2 kelas (buang netral) — lebih mudah dari 3 kelas
    ds2 = ds[ds["label3"] != 0].copy()
    ds2["label3"] = (ds2["label3"] > 0).astype(int)
    results_2 = {}
    for ph, label in [("pra", "A_pra_event_2cls"), ("pasca", "B_pasca_event_2cls")]:
        sub = ds2[ds2["phase"] == ph].copy()
        results_2[ph] = evaluate(label, sub)
    results_2["all"] = evaluate("all_news_2cls", ds2)

    out = {"3_class": results, "2_class": results_2}
    with open("reports/phase_model_results.json", "w") as f:
        json.dump(out, f, indent=2, default=str)

    print(json.dumps(out, indent=2, default=str))
    return out


if __name__ == "__main__":
    main()
