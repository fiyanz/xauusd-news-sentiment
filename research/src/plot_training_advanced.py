"""Visualisasi lanjutan hasil training model XAUUSD (6 panel).

Panel:
  A. Kurva walk-forward CV per fold (rank IC) untuk tiap model.
  B. Distribusi residual test: champion (Ridge) vs baseline (LightGBM).
  C. QQ plot residual champion vs normal (+ ringkasan bentuk distribusi).
  D. Koefisien Ridge champion — 15 fitur teratas, warna menandakan arah.
  E. Dampak berita per topik: rata-rata return 4H per kelompok sentimen.
  F. Perbandingan split (chronological / news_era / out_of_time).

Sumber data:
  reports/full_metrics_evaluation.json, reports/significance.json,
  reports/fair_comparison_results.json, reports/sentiment_impact.json,
  research/experiments/h1-embeddings/results.json + results_v2.json,
  models/champion_fair_model.joblib, data/processed/bucketed_features.parquet.

Baseline WAJIB konsisten dengan kartu B (t_2e439417):
  models/champion_fair_model.joblib -> baseline_model + baseline_feature_cols
  (LightGBM/LGBMRegressor, 21 fitur). Skrip menolak jalan bila lorensi
  antar-report tidak memenuhi definisi itu.

Jalankan dari services/sentiment-analysis:
  .venv/bin/python ../../research/src/plot_training_advanced.py
Opsi:
  --recompute-cv   abaikan cache CV dan hitung ulang walk-forward CV.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import stats

# --------------------------------------------------------------------------
# Path resolution: skrip berada di <repo>/research/src/, layanan di
# <repo>/services/sentiment-analysis. Dicari dari lokasi file dulu, lalu cwd.
# --------------------------------------------------------------------------
HERE = Path(__file__).resolve()
CANDIDATES = [
    HERE.parents[2] / "services" / "sentiment-analysis",
    Path.cwd(),
    Path.cwd() / "services" / "sentiment-analysis",
]
SERVICE = next(
    (p for p in CANDIDATES if (p / "reports" / "full_metrics_evaluation.json").exists()),
    None,
)
if SERVICE is None:
    raise SystemExit(
        "Tidak menemukan services/sentiment-analysis/reports/full_metrics_evaluation.json. "
        "Jalankan dari direktori layanan."
    )
sys.path.insert(0, str(SERVICE))

OUT_DIR = SERVICE / "research" / "to_human"
CACHE_DIR = SERVICE / "research" / "experiments" / "advanced"
OUT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

REPORTS = SERVICE / "reports"
BUNDLE_PATH = SERVICE / "models" / "champion_fair_model.joblib"
FEATURES_PATH = SERVICE / "data" / "processed" / "bucketed_features.parquet"

# Warna konsisten dengan plot_training.py yang sudah ada.
CHAMP_COLOR = "#DD8452"
MODEL_COLORS = {
    "Random_Forest": "#4C72B0",
    "XGBoost": "#8172B3",
    "LightGBM": "#55A868",
    "Ridge_Linear": CHAMP_COLOR,
}
BASELINE_COLOR = "#55A868"
FULL_COLOR = "#C44E52"
POS_COLOR = "#2E7D32"
NEU_COLOR = "#9E9E9E"
NEG_COLOR = "#C44E52"

MODEL_ORDER = ["Random_Forest", "XGBoost", "LightGBM", "Ridge_Linear"]
N_SPLITS = 5
SEED = 42


def load_json(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


# --------------------------------------------------------------------------
# 0. Konsistensi baseline (definisi kartu B)
# --------------------------------------------------------------------------
def check_baseline_consistency(metrics: dict, fair: dict, sig: dict) -> dict:
    """Pastikan semua report memakai baseline bundle yang sama (kartu B)."""
    desc = metrics.get("baseline", {})
    fair_base = fair.get("models", {}).get("baseline", {})
    fair_delta = fair.get("delta_alpha", {})

    checks = {
        "baseline_name=LightGBM": desc.get("baseline_name") == "LightGBM",
        "baseline_feature_count=21": desc.get("baseline_feature_count") == 21,
        "baseline_source=bundle": str(desc.get("baseline_model_source", "")).endswith(
            "champion_fair_model.joblib"
        ),
        "significance baseline IC == fair baseline IC": (
            abs(float(sig.get("baseline_rank_ic", np.nan)) - float(fair_base.get("spearman_rank_ic", np.nan)))
            < 1e-9
        ),
        "delta rank IC konsisten": (
            abs(float(sig.get("delta_rank_ic", np.nan)) - float(fair_delta.get("rank_ic_improvement", np.nan)))
            < 1e-9
        ),
        "sentiment_adds_value konsisten": (
            sig.get("sentiment_adds_value") == fair_delta.get("sentiment_adds_value")
        ),
    }
    checks["sentiment_adds_value=false"] = sig.get("sentiment_adds_value") is False
    return checks


# --------------------------------------------------------------------------
# A. Walk-forward CV per fold
# --------------------------------------------------------------------------
def compute_cv_folds(force: bool = False) -> dict:
    """Hitung (atau baca cache) metrik per fold untuk tiap model.

    Replika persis loop CV di ``src/models/train.train_models``: reducer
    (scaler + PCA) difit pada lipatan train saja, anti look-ahead.
    """
    cache = CACHE_DIR / "cv_folds.json"
    if cache.exists() and not force:
        return load_json(cache)

    import joblib
    import lightgbm as lgb
    import xgboost as xgb
    from sklearn.base import clone
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.linear_model import Ridge
    from sklearn.model_selection import TimeSeriesSplit

    from src.features.reduce import FeatureReducer
    from src.models.train import compute_regression_metrics

    df = pd.read_parquet(FEATURES_PATH)
    train_val = df[df["split"].isin(["train", "val"])].reset_index(drop=True)
    y = train_val["ret_4h"].to_numpy(dtype=float)
    vol = train_val["vol_pre"].to_numpy(dtype=float)

    models = {
        "Random_Forest": RandomForestRegressor(
            n_estimators=150, max_depth=3, min_samples_leaf=20, max_features=0.6, random_state=SEED
        ),
        "XGBoost": xgb.XGBRegressor(
            n_estimators=100,
            learning_rate=0.01,
            max_depth=3,
            subsample=0.8,
            colsample_bytree=0.8,
            random_state=SEED,
            verbosity=0,
        ),
        "LightGBM": lgb.LGBMRegressor(
            n_estimators=100,
            learning_rate=0.01,
            num_leaves=10,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_samples=15,
            random_state=SEED,
            verbose=-1,
        ),
        "Ridge_Linear": Ridge(alpha=10.0, random_state=SEED),
    }

    tscv = TimeSeriesSplit(n_splits=N_SPLITS)
    folds: dict[str, dict] = {}
    for k, (tr_idx, va_idx) in enumerate(tscv.split(train_val), start=1):
        fold_reducer = FeatureReducer().fit(train_val.iloc[tr_idx])
        X_tr = fold_reducer.transform(train_val.iloc[tr_idx]).to_numpy(dtype=float)
        X_va = fold_reducer.transform(train_val.iloc[va_idx]).to_numpy(dtype=float)
        rec = {
            "fold": k,
            "n_train": int(len(tr_idx)),
            "n_val": int(len(va_idx)),
            "train_start": str(train_val["time_bucket"].iloc[tr_idx[0]]),
            "train_end": str(train_val["time_bucket"].iloc[tr_idx[-1]]),
            "val_start": str(train_val["time_bucket"].iloc[va_idx[0]]),
            "val_end": str(train_val["time_bucket"].iloc[va_idx[-1]]),
            "metrics": {},
        }
        for name, estimator in models.items():
            m = clone(estimator)
            m.fit(X_tr, y[tr_idx])
            rec["metrics"][name] = compute_regression_metrics(
                y[va_idx], m.predict(X_va), len(fold_reducer.feature_cols), vol[va_idx]
            )
        folds[str(k)] = rec
        print(f"[CV] fold {k}: n_train={len(tr_idx)} n_val={len(va_idx)} selesai")

    cv_summary = {
        name: {
            "rank_ic": round(float(np.mean([f["metrics"][name]["rank_ic"] for f in folds.values()])), 4),
            "hit_ratio_sig": round(float(np.mean([f["metrics"][name]["hit_ratio_sig"] for f in folds.values()])), 2),
            "mae_pct": round(float(np.mean([f["metrics"][name]["mae_pct"] for f in folds.values()])), 4),
        }
        for name in MODEL_ORDER
    }
    payload = {
        "n_splits": N_SPLITS,
        "seed": SEED,
        "folds": folds,
        "cv_summary_recomputed": cv_summary,
    }
    with open(cache, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"[CV] cache tersimpan: {cache}")
    return payload


# --------------------------------------------------------------------------
# B/C. Prediksi test -> residual
# --------------------------------------------------------------------------
def compute_test_residuals() -> dict:
    """Prediksi champion & baseline pada split test -> residual (satuan return)."""
    import joblib

    from src.features.reduce import apply_bundle_features

    bundle = joblib.load(BUNDLE_PATH)
    df = pd.read_parquet(FEATURES_PATH)
    test = df[df["split"] == "test"].reset_index(drop=True)

    X = apply_bundle_features(bundle, test).to_numpy(dtype=float)
    feature_cols = list(bundle["feature_cols"])
    y = test[bundle["target_col"]].to_numpy(dtype=float)

    champ = bundle["champion_model"]
    base = bundle["baseline_model"]
    p_champ = champ.predict(X)

    base_cols = list(bundle["baseline_feature_cols"])
    missing = [c for c in base_cols if c not in feature_cols]
    if missing:
        raise SystemExit(f"baseline_feature_cols tidak ada di feature_cols: {missing}")
    base_idx = [feature_cols.index(c) for c in base_cols]
    p_base = base.predict(X[:, base_idx])

    return {
        "n": int(len(test)),
        "time_min": str(test["time_bucket"].min()),
        "time_max": str(test["time_bucket"].max()),
        "champion_name": bundle.get("champion_name"),
        "baseline_name": bundle.get("baseline_name"),
        "baseline_feature_count": len(base_cols),
        "y": y,
        "p_champ": p_champ,
        "p_base": p_base,
        "res_champ": y - p_champ,
        "res_base": y - p_base,
    }


# --------------------------------------------------------------------------
# Plotting
# --------------------------------------------------------------------------
def plot_cv(ax, cv: dict, champion: str) -> None:
    folds = cv["folds"]
    x = np.arange(1, len(folds) + 1)
    for name in MODEL_ORDER:
        vals = [folds[str(k)]["metrics"][name]["rank_ic"] for k in x]
        mean = float(np.mean(vals))
        lw = 2.4 if name == champion else 1.4
        ax.plot(
            x,
            vals,
            marker="o",
            lw=lw,
            color=MODEL_COLORS[name],
            label=f"{name} (mean {mean:.4f})",
        )
        for xi, v in zip(x, vals):
            ax.annotate(
                f"{v:.3f}",
                (xi, v),
                textcoords="offset points",
                xytext=(0, 4),
                ha="center",
                fontsize=6,
                color=MODEL_COLORS[name],
            )
    ax.axhline(0, color="black", lw=0.6)
    ax.set_xticks(x)
    ax.set_xlabel("Lipatan walk-forward (chronological)", fontsize=9)
    ax.set_ylabel("Spearman Rank IC", fontsize=9)
    ax.set_title("A. Kurva CV per Fold — Rank IC per Model", fontsize=11, fontweight="bold")
    ax.legend(fontsize=7.5, loc="best")
    ax.grid(alpha=0.25, lw=0.5)
    ax.tick_params(labelsize=8)


def plot_residuals(ax, res: dict) -> None:
    rc = res["res_champ"] * 100
    rb = res["res_base"] * 100
    bins = np.linspace(min(rc.min(), rb.min()), max(rc.max(), rb.max()), 42)
    ax.hist(rc, bins=bins, density=True, alpha=0.55, color=CHAMP_COLOR, edgecolor="white",
            label=f"Champion {res['champion_name']} (std {rc.std():.3f}%)")
    ax.hist(rb, bins=bins, density=True, alpha=0.40, color=BASELINE_COLOR, edgecolor="white",
            label=f"Baseline {res['baseline_name']} (std {rb.std():.3f}%)")
    xs = np.linspace(rc.min(), rc.max(), 200)
    ax.plot(xs, stats.norm.pdf(xs, rc.mean(), rc.std()), color="black", lw=1.1, ls="--",
            label="Normal fit (champion)")
    ax.axvline(0, color="red", lw=0.8, ls=":")
    ax.set_xlabel("Residual (actual − prediksi), %", fontsize=9)
    ax.set_ylabel("Kepadatan", fontsize=9)
    ax.set_title(f"B. Distribusi Residual Test (n={res['n']:,})", fontsize=11, fontweight="bold")
    ax.legend(fontsize=7.5)
    ax.grid(alpha=0.25, lw=0.5)
    ax.tick_params(labelsize=8)


def plot_qq(ax, res: dict) -> None:
    rc = res["res_champ"] * 100
    rb = res["res_base"] * 100
    (osm_c, osr_c), (slope_c, int_c, r_c) = stats.probplot(rc, dist="norm")
    (osm_b, osr_b), _ = stats.probplot(rb, dist="norm")
    ax.scatter(osm_c, osr_c, s=14, color=CHAMP_COLOR, alpha=0.75, label=f"Champion (r={r_c:.4f})")
    ax.scatter(osm_b, osr_b, s=10, color=BASELINE_COLOR, alpha=0.45, label="Baseline")
    lim = float(max(abs(osm_c.min()), abs(osm_c.max())))
    ax.plot([-lim, lim], [-lim, lim], color="black", lw=0.9, ls="--", label="Normal (y=x)")
    stat, p_norm = stats.normaltest(rc)
    skew = stats.skew(rc)
    kurt = stats.kurtosis(rc)
    ax.text(
        0.03, 0.97,
        f"D'Agostino p={p_norm:.2e}\nskew={skew:+.3f}, excess kurt={kurt:+.3f}",
        transform=ax.transAxes, va="top", fontsize=7.5,
        bbox=dict(boxstyle="round", fc="#F5F5F5", ec="#999"),
    )
    ax.set_xlabel("Kuantil teoretis (normal)", fontsize=9)
    ax.set_ylabel("Kuantil sampel residual", fontsize=9)
    ax.set_title("C. QQ Plot Residual vs Normal", fontsize=11, fontweight="bold")
    ax.legend(fontsize=7.5, loc="lower right")
    ax.grid(alpha=0.25, lw=0.5)
    ax.tick_params(labelsize=8)


def plot_coefficients(ax, bundle: dict) -> None:
    coef = np.asarray(bundle["champion_model"].coef_, dtype=float).ravel() * 1e4  # basis point per 1 SD
    cols = list(bundle["feature_cols"])
    if len(coef) != len(cols):
        raise SystemExit(f"coef ({len(coef)}) != feature_cols ({len(cols)})")
    order = np.argsort(np.abs(coef))[::-1][:15]
    ypos = np.arange(len(order))[::-1]
    colors = [POS_COLOR if coef[i] > 0 else NEG_COLOR for i in order]
    ax.barh(ypos, coef[order], color=colors, edgecolor="white")
    ax.set_yticks(ypos)
    ax.set_yticklabels([cols[i] for i in order], fontsize=7.5)
    pad = float(np.abs(coef).max()) * 0.03
    for yp, i in zip(ypos, order):
        v = coef[i]
        ax.text(
            v + (pad if v > 0 else -pad),
            yp,
            f"{v:+.2f}",
            va="center",
            ha="left" if v > 0 else "right",
            fontsize=7,
        )
    ax.axvline(0, color="black", lw=0.7)
    ax.set_xlabel("Koefisien Ridge (basis point per 1 SD)", fontsize=9)
    ax.set_title("D. Koefisien Ridge Champion — 15 Teratas", fontsize=11, fontweight="bold")
    from matplotlib.patches import Patch

    ax.legend(
        handles=[Patch(color=POS_COLOR, label="meningkatkan return"),
                 Patch(color=NEG_COLOR, label="menurunkan return")],
        fontsize=7.5, loc="lower right",
    )
    ax.grid(alpha=0.25, lw=0.5, axis="x")
    ax.tick_params(labelsize=8)


def plot_sentiment_impact(ax, impact: dict) -> None:
    vader = impact["lexicons"]["vader"]["by_topic"]
    topics = list(vader.keys())
    groups = ["positif", "netral", "negatif"]
    colors = {"positif": POS_COLOR, "netral": NEU_COLOR, "negatif": NEG_COLOR}
    x = np.arange(len(topics))
    width = 0.26
    all_lo, all_hi = [], []
    for j, g in enumerate(groups):
        means, los, his, ns = [], [], [], []
        for t in topics:
            grp = vader[t]["groups"][g]
            means.append(grp["mean_ret_4h"] * 1e4)
            los.append(grp["ci95_low"] * 1e4)
            his.append(grp["ci95_high"] * 1e4)
            ns.append(grp["n"])
        means, los, his = map(np.asarray, (means, los, his))
        all_lo.append(los)
        all_hi.append(his)
        offset = (j - 1) * width
        ax.bar(
            x + offset, means, width,
            yerr=[means - los, his - means], capsize=3,
            color=colors[g], edgecolor="white", label=g,
        )
    all_lo = np.concatenate(all_lo)
    all_hi = np.concatenate(all_hi)
    span = float(all_hi.max() - all_lo.min())
    label_off = span * 0.03
    for j, g in enumerate(groups):
        offset = (j - 1) * width
        for t_i, t in enumerate(topics):
            grp = vader[t]["groups"][g]
            m = grp["mean_ret_4h"] * 1e4
            lo = grp["ci95_low"] * 1e4
            hi = grp["ci95_high"] * 1e4
            y = (hi if m >= 0 else lo) + (label_off if m >= 0 else -label_off)
            ax.text(x[t_i] + offset, y, f"{m:.2f}", ha="center",
                    fontsize=6.5, color=colors[g],
                    va="bottom" if m >= 0 else "top")
    ax.set_ylim(all_lo.min() - span * 0.16, all_hi.max() + span * 0.16)
    labels = []
    for t in topics:
        n = vader[t]["n_articles"]
        p = vader[t]["pos_vs_neg_test"]["p_value"]
        labels.append(f"{t}\nn={n:,}\np={p:.3f}")
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=7)
    ax.axhline(0, color="black", lw=0.7)
    ax.set_ylabel("Rata-rata return 4H (basis point)", fontsize=9)
    ax.set_title("E. Dampak Berita per Topik — Return 4H per Sentimen (VADER)",
                 fontsize=11, fontweight="bold")
    ax.legend(fontsize=8)
    ax.grid(alpha=0.25, lw=0.5, axis="y")
    ax.tick_params(labelsize=8)


def plot_split_comparison(ax, results_v2: dict, results_v1: dict) -> None:
    rows = [
        ("chronological", results_v2["chronological"]),
        ("news_era", results_v1["news_era"]),
        ("out_of_time", results_v2["out_of_time"]),
    ]
    labels = [f"{name}\nn={r.get('n', r.get('n_test')):,}" for name, r in rows]
    base = np.array([r["baseline_ic"] for _, r in rows])
    full = np.array([r["full_ic"] for _, r in rows])
    x = np.arange(len(rows))
    width = 0.35
    ax.bar(x - width / 2, base, width, color=BASELINE_COLOR, edgecolor="white", label="Baseline (21 fitur)")
    ax.bar(x + width / 2, full, width, color=FULL_COLOR, edgecolor="white", label="Full (+embedding)")
    for xi, (b, f) in enumerate(zip(base, full)):
        ax.text(xi - width / 2, b + 0.0008, f"{b:.4f}", ha="center", fontsize=7.5, color=BASELINE_COLOR)
        ax.text(xi + width / 2, f + 0.0008, f"{f:.4f}", ha="center", fontsize=7.5, color=FULL_COLOR)
        r = rows[xi][1]
        boot = r["bootstrap"]
        ax.text(xi, max(b, f) + 0.005, f"Δ {r['delta']:+.4f}\np={boot['p_value']:.3f}",
                ha="center", fontsize=7.5, fontweight="bold")
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=8)
    ax.set_ylabel("Spearman Rank IC", fontsize=9)
    ax.set_title("F. Perbandingan Split — Baseline vs Full (eksperimen H1)",
                 fontsize=11, fontweight="bold")
    ax.set_ylim(0, max(base.max(), full.max()) * 1.35)
    ax.legend(fontsize=8)
    ax.grid(alpha=0.25, lw=0.5, axis="y")
    ax.tick_params(labelsize=8)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recompute-cv", action="store_true", help="Hitung ulang CV, abaikan cache.")
    args = parser.parse_args()

    metrics = load_json(REPORTS / "full_metrics_evaluation.json")
    fair = load_json(REPORTS / "fair_comparison_results.json")
    sig = load_json(REPORTS / "significance.json")
    impact = load_json(REPORTS / "sentiment_impact.json")
    results_v1 = load_json(SERVICE / "research" / "experiments" / "h1-embeddings" / "results.json")
    results_v2 = load_json(SERVICE / "research" / "experiments" / "h1-embeddings" / "results_v2.json")

    checks = check_baseline_consistency(metrics, fair, sig)
    print("=== Konsistensi baseline (kartu B) ===")
    for k, v in checks.items():
        print(f"  [{'PASS' if v else 'FAIL'}] {k}")
    if not all(checks.values()):
        raise SystemExit("Definisi baseline antar-report TIDAK konsisten; visualisasi dibatalkan.")

    import joblib

    bundle = joblib.load(BUNDLE_PATH)
    champion = metrics["champion_name"]
    print(f"\nChampion: {champion} ({metrics['selection_method']}) | test n={metrics['test_samples']}")

    cv = compute_cv_folds(force=args.recompute_cv)
    print("\n=== CV ulang vs bundle cv_summary ===")
    for name in MODEL_ORDER:
        rec = cv["cv_summary_recomputed"][name]["rank_ic"]
        bundled = bundle.get("cv_summary", {}).get(name, {}).get("rank_ic")
        flag = "OK" if bundled is not None and abs(rec - bundled) < 5e-4 else "BEDA"
        print(f"  {name:15s} ulang={rec:.4f} bundle={bundled} [{flag}]")

    res = compute_test_residuals()
    print(f"\nResidual test n={res['n']} | {res['time_min']} .. {res['time_max']}")
    print(f"  champion std={res['res_champ'].std()*100:.4f}% | baseline std={res['res_base'].std()*100:.4f}%")

    fig, axes = plt.subplots(3, 2, figsize=(15, 16))
    fig.suptitle(
        "XAUUSD News Sentiment — Visualisasi Lanjutan Hasil Training",
        fontsize=15, fontweight="bold",
    )

    plot_cv(axes[0, 0], cv, champion)
    plot_residuals(axes[0, 1], res)
    plot_qq(axes[1, 0], res)
    plot_coefficients(axes[1, 1], bundle)
    plot_sentiment_impact(axes[2, 0], impact)
    plot_split_comparison(axes[2, 1], results_v2, results_v1)

    footnote = (
        "Baseline (panel B, C): models/champion_fair_model.joblib -> baseline_model + baseline_feature_cols "
        "(LightGBM, 21 fitur) — definisi kartu B.\n"
        "Panel A: walk-forward CV 5 lipat, reducer PCA difit per lipatan (anti look-ahead). "
        "Panel F: eksperimen H1 (Ridge, baseline 21 fitur resmi), sumber research/experiments/h1-embeddings/results*.json."
    )
    fig.text(0.5, 0.005, footnote, ha="center", va="bottom", fontsize=7.5, color="#444")

    plt.tight_layout(rect=[0, 0.02, 1, 0.97])
    png = OUT_DIR / "training_advanced.png"
    svg = OUT_DIR / "training_advanced.svg"
    plt.savefig(png, dpi=140, bbox_inches="tight")
    plt.savefig(svg, bbox_inches="tight")
    print(f"\ntersimpan: {png}")
    print(f"tersimpan: {svg}")


if __name__ == "__main__":
    main()
