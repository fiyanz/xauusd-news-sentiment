"""Train Fair Baseline vs Full Model benchmark with 5-fold Walk-Forward Cross Validation."""

import os
from pathlib import Path
import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.base import clone
from sklearn.linear_model import Ridge
from sklearn.model_selection import TimeSeriesSplit
import yaml


def load_config() -> dict:
    for path in [Path("config.yaml"), Path("services/sentiment-analysis/config.yaml")]:
        if path.exists():
            with open(path, "r") as f:
                return yaml.safe_load(f)
    return {}


def compute_metrics(y_pred: np.ndarray, y_true: np.ndarray, vol: np.ndarray) -> dict:
    """Compute primary benchmark metrics: Spearman Rank IC, Quintile Spread, Directional Hit Ratio."""
    # a) Spearman Rank IC
    ic, pval = spearmanr(y_pred, y_true)
    if np.isnan(ic):
        ic, pval = 0.0, 1.0

    # b) Top 20% vs Bottom 20% Quintile return spread
    q80 = float(np.percentile(y_pred, 80))
    q20 = float(np.percentile(y_pred, 20))
    top_mask = y_pred >= q80
    bot_mask = y_pred <= q20
    if top_mask.sum() > 0 and bot_mask.sum() > 0:
        quintile_spread = float(np.mean(y_true[top_mask]) - np.mean(y_true[bot_mask]))
    else:
        quintile_spread = 0.0

    # c) Directional Hit Ratio on significant moves (|return| > 0.5 * rolling vol)
    sig_mask = np.abs(y_true) > (0.5 * vol)
    if sig_mask.sum() > 0:
        hit_ratio = float(np.mean(np.sign(y_pred[sig_mask]) == np.sign(y_true[sig_mask])))
    else:
        hit_ratio = float(np.mean(np.sign(y_pred) == np.sign(y_true)))

    return {
        "spearman_ic": round(float(ic), 4),
        "spearman_pval": round(float(pval), 5),
        "quintile_spread": round(float(quintile_spread), 6),
        "directional_hit_ratio": round(float(hit_ratio), 4),
    }


def train_fair_benchmark(
    features_parquet: str = "data/processed/bucketed_features.parquet",
    output_model_path: str = "models/champion_fair_model.joblib",
    target_col: str = "ret_4h",
    n_splits: int = 5,
    seed: int = 42,
) -> dict:
    """Run 5-Fold Walk-Forward Cross Validation comparing Fair Baseline vs Full Model."""
    os.makedirs(os.path.dirname(output_model_path), exist_ok=True)
    print(f"[TrainFair] Loading dataset from {features_parquet}...")
    df = pd.read_parquet(features_parquet)

    # Strictly train on train + val partitions (Test set stays untouched!)
    train_val_df = df[df["split"].isin(["train", "val"])].reset_index(drop=True)
    print(f"[TrainFair] Training Walk-Forward CV on {len(train_val_df)} Train+Val samples...")

    # Fair Baseline features: macro surprise + temporal + lagged macro context
    macro_cols = [c for c in df.columns if c.startswith("macro_")]
    baseline_cols = [
        "z_score",
        "surprise_val",
        "has_event",
        "hour_utc",
        "dayofweek",
        "session_Asia",
        "session_London",
        "session_NewYork",
    ] + macro_cols

    # Full Model features: Baseline features + sentiment + topic interaction features + TF-IDF
    topic_cols = [c for c in df.columns if c.startswith("topic_") and not c.endswith("_x_sentiment")]
    inter_cols = [c for c in df.columns if c.startswith("sentiment_x_")]
    sentiment_cols = ["sentiment_score"] + topic_cols + inter_cols
    tfidf_cols = [c for c in df.columns if c.startswith("tfidf_")]

    # ponytail: full feature set combines interactions and text; prune low-variance tfidf if dimension explodes
    full_cols = baseline_cols + sentiment_cols + tfidf_cols

    # Imputasi NaN -> 0.0 (netral) dengan pencatatan jumlah imputasi di bundle.
    feature_nan_imputed = int(train_val_df[full_cols].isna().sum().sum())
    train_val_df = train_val_df.copy()
    train_val_df[full_cols] = train_val_df[full_cols].fillna(0.0)

    X_baseline = train_val_df[baseline_cols].values
    X_full = train_val_df[full_cols].values
    y = train_val_df[target_col].values
    vol = train_val_df["vol_pre"].values

    models_to_run = {
        "Baseline_Ridge": (Ridge(alpha=10.0, random_state=seed), X_baseline, baseline_cols),
        "Baseline_LightGBM": (
            lgb.LGBMRegressor(
                n_estimators=100,
                learning_rate=0.01,
                num_leaves=10,
                subsample=0.8,
                colsample_bytree=0.8,
                min_child_samples=15,
                random_state=seed,
                verbose=-1,
            ),
            X_baseline,
            baseline_cols,
        ),
        "Full_Ridge": (Ridge(alpha=10.0, random_state=seed), X_full, full_cols),
        "Full_LightGBM": (
            lgb.LGBMRegressor(
                n_estimators=100,
                learning_rate=0.01,
                num_leaves=10,
                subsample=0.8,
                colsample_bytree=0.8,
                min_child_samples=15,
                random_state=seed,
                verbose=-1,
            ),
            X_full,
            full_cols,
        ),
    }

    tscv = TimeSeriesSplit(n_splits=n_splits)
    fold_results = {m: {"ic": [], "pval": [], "spread": [], "hit": []} for m in models_to_run}

    fold = 1
    for tr_idx, val_idx in tscv.split(X_baseline):
        y_tr, y_val = y[tr_idx], y[val_idx]
        vol_val = vol[val_idx]

        for m_name, (estimator, X_mat, _) in models_to_run.items():
            model = clone(estimator)
            model.fit(X_mat[tr_idx], y_tr)
            y_pred = model.predict(X_mat[val_idx])

            m_scores = compute_metrics(y_pred, y_val, vol_val)
            fold_results[m_name]["ic"].append(m_scores["spearman_ic"])
            fold_results[m_name]["pval"].append(m_scores["spearman_pval"])
            fold_results[m_name]["spread"].append(m_scores["quintile_spread"])
            fold_results[m_name]["hit"].append(m_scores["directional_hit_ratio"])

        fold += 1

    # Summarize Walk-Forward CV
    cv_summary = {}
    print("\n--- 5-Fold Walk-Forward Cross Validation Summary ---")
    for m_name, res in fold_results.items():
        avg_ic = float(np.mean(res["ic"]))
        avg_spread = float(np.mean(res["spread"]))
        avg_hit = float(np.mean(res["hit"]))
        cv_summary[m_name] = {
            "mean_spearman_ic": round(avg_ic, 4),
            "mean_quintile_spread": round(avg_spread, 6),
            "mean_directional_hit_ratio": round(avg_hit, 4),
        }
        print(
            f"[{m_name:18s}] Mean IC: {avg_ic:+.4f} | "
            f"Quintile Spread: {avg_spread:+.6f} | "
            f"Directional Hit: {avg_hit:.4f}"
        )

    # Identify best baseline and best full model
    best_baseline_name = max(
        ["Baseline_Ridge", "Baseline_LightGBM"],
        key=lambda k: cv_summary[k]["mean_spearman_ic"],
    )
    best_full_name = max(
        ["Full_Ridge", "Full_LightGBM"],
        key=lambda k: cv_summary[k]["mean_spearman_ic"],
    )

    # Retrain on full Train+Val set
    trained_baseline = clone(models_to_run[best_baseline_name][0]).fit(X_baseline, y)
    trained_full = clone(models_to_run[best_full_name][0]).fit(X_full, y)

    # Designate champion
    champion_name = best_full_name
    champion_model = trained_full

    champion_bundle = {
        "champion_name": champion_name,
        "champion_model": champion_model,
        "model": champion_model,  # alias
        "model_name": champion_name,  # alias
        "champion_feature_cols": full_cols,
        "feature_cols": full_cols,  # alias
        "baseline_name": best_baseline_name,
        "baseline_model": trained_baseline,
        "baseline_feature_cols": baseline_cols,
        "target_col": target_col,
        "cv_summary": cv_summary,
        "seed": seed,
        "feature_nan_imputed": feature_nan_imputed,
    }

    joblib.dump(champion_bundle, output_model_path)
    print(f"\n[TrainFair] Saved champion bundle to {output_model_path}")
    print(f"Selected Champion: {champion_name} | Fair Baseline: {best_baseline_name}")

    return cv_summary


if __name__ == "__main__":
    cfg = load_config()
    proc_dir = cfg.get("data", {}).get("processed_dir", "data/processed")
    train_fair_benchmark(
        features_parquet=os.path.join(proc_dir, "bucketed_features.parquet"),
        output_model_path="models/champion_fair_model.joblib",
        target_col="ret_4h",
        n_splits=cfg.get("split", {}).get("walk_forward_folds", 5),
        seed=cfg.get("project", {}).get("seed", 42),
    )
