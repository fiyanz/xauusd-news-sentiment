"""Multi-Model Training Engine (Random Forest, LightGBM, XGBoost, Ridge).

Includes 5-Fold Walk-Forward Cross Validation and computes MAE, MSE, RMSE, MAPE, R2, and Adjusted R2.
"""

import os
from pathlib import Path
import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.base import clone
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import TimeSeriesSplit
import xgboost as xgb
import yaml


def load_config() -> dict:
    for path in [Path("config.yaml"), Path("services/sentiment-analysis/config.yaml")]:
        if path.exists():
            with open(path, "r") as f:
                return yaml.safe_load(f)
    return {}


def compute_regression_metrics(y_true: np.ndarray, y_pred: np.ndarray, num_features: int, vol: np.ndarray = None) -> dict:
    """Compute MAE, MSE, RMSE, MAPE, R2, Adjusted R2, Hit Ratio, and Rank IC."""
    n = len(y_true)
    mae = float(mean_absolute_error(y_true, y_pred))
    mse = float(mean_squared_error(y_true, y_pred))
    rmse = float(np.sqrt(mse))

    # MAPE: avoid division by zero near 0 return
    eps = 1e-4
    mape = float(np.mean(np.abs((y_true - y_pred) / np.maximum(np.abs(y_true), eps))) * 100)

    # R2 & Adjusted R2
    r2 = float(r2_score(y_true, y_pred))
    if n > num_features + 1:
        adj_r2 = float(1.0 - ((1.0 - r2) * (n - 1) / (n - num_features - 1)))
    else:
        adj_r2 = float(r2)

    # Directional Hit Ratio
    hit_all = float(np.mean(np.sign(y_pred) == np.sign(y_true)) * 100)
    if vol is not None:
        sig_mask = np.abs(y_true) > (0.5 * vol)
        hit_sig = float(np.mean(np.sign(y_pred[sig_mask]) == np.sign(y_true[sig_mask])) * 100) if sig_mask.sum() > 0 else hit_all
    else:
        hit_sig = hit_all

    # Spearman Rank IC
    ic, pval = spearmanr(y_pred, y_true)
    if np.isnan(ic):
        ic, pval = 0.0, 1.0

    return {
        "mae": round(mae, 6),
        "mae_pct": round(mae * 100, 4),
        "mse": round(mse, 8),
        "rmse": round(rmse, 6),
        "rmse_pct": round(rmse * 100, 4),
        "mape_pct": round(mape, 2),
        "r2": round(r2, 4),
        "adj_r2": round(adj_r2, 4),
        "hit_ratio_sig": round(hit_sig, 2),
        "hit_ratio_all": round(hit_all, 2),
        "rank_ic": round(float(ic), 4),
        "rank_pval": round(float(pval), 5),
    }


def select_champion(cv_summary: dict, metric: str = "rank_ic") -> str:
    """Select the champion by the best mean cross-validation metric.

    No model name is hardcoded: the champion is the argmax of ``cv_summary``.
    ``metric`` must be ``rank_ic`` (contract: ``cv_mean_rank_ic``) or
    ``hit_ratio_sig`` (contract: ``cv_mean_hit_sig``).
    """
    if metric not in ("rank_ic", "hit_ratio_sig"):
        raise ValueError(f"Unsupported champion metric: {metric!r}")
    valid = {name: scores for name, scores in cv_summary.items() if metric in scores}
    if not valid:
        raise ValueError(f"cv_summary has no '{metric}' entries")
    return max(valid, key=lambda name: valid[name][metric])


def train_models(
    features_parquet: str = "data/processed/bucketed_features.parquet",
    output_model_dir: str = "models",
    target_col: str = "ret_4h",
    n_splits: int = 5,
    seed: int = 42,
    selection_metric: str = "rank_ic",
) -> dict:
    """Train multiple algorithms with 5-Fold Walk-Forward Cross Validation on Train+Val partitions."""
    os.makedirs(output_model_dir, exist_ok=True)
    print(f"[Train] Loading features from {features_parquet}...")
    df = pd.read_parquet(features_parquet)

    train_df = df[df["split"] == "train"].reset_index(drop=True)
    val_df = df[df["split"] == "val"].reset_index(drop=True)
    train_val_df = pd.concat([train_df, val_df]).reset_index(drop=True)

    print(f"[Train] Training on Train+Val partition: {len(train_val_df)} samples (strictly chronological).")

    macro_cols = [c for c in df.columns if c.startswith("macro_")]
    base_cols = [
        "z_score",
        "surprise_val",
        "has_event",
        "hour_utc",
        "dayofweek",
        "session_Asia",
        "session_London",
        "session_NewYork",
    ] + macro_cols
    topic_cols = [c for c in df.columns if c.startswith("topic_") and not c.endswith("_x_sentiment")]
    inter_cols = [c for c in df.columns if c.startswith("sentiment_x_")]
    full_cols = base_cols + ["sentiment_score"] + topic_cols + inter_cols

    # Missing feature values (e.g. surprise NaN when no macro release overlaps
    # the news window) are imputed with 0.0 — the neutral encoding for
    # "no event" — and the imputation count is recorded in the bundle so the
    # report can disclose it. NaN is never silently dropped.
    feature_nan_imputed = int(train_val_df[full_cols].isna().sum().sum())
    train_val_df = train_val_df.copy()
    train_val_df[full_cols] = train_val_df[full_cols].fillna(0.0)

    X_train = train_val_df[full_cols].values
    y_train = train_val_df[target_col].values
    vol_train = train_val_df["vol_pre"].values

    models = {
        "Random_Forest": RandomForestRegressor(
            n_estimators=150, max_depth=3, min_samples_leaf=20, max_features=0.6, random_state=seed
        ),
        "XGBoost": xgb.XGBRegressor(
            n_estimators=100,
            learning_rate=0.01,
            max_depth=3,
            subsample=0.8,
            colsample_bytree=0.8,
            random_state=seed,
            verbosity=0,
        ),
        "LightGBM": lgb.LGBMRegressor(
            n_estimators=100,
            learning_rate=0.01,
            num_leaves=10,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_samples=15,
            random_state=seed,
            verbose=-1,
        ),
        "Ridge_Linear": Ridge(alpha=10.0, random_state=seed),
    }

    # Walk-Forward Cross Validation
    tscv = TimeSeriesSplit(n_splits=n_splits)
    cv_scores = {name: [] for name in models}

    print(f"\n--- Running 5-Fold Walk-Forward Cross Validation ---")
    for tr_idx, val_idx in tscv.split(X_train):
        y_tr, y_va = y_train[tr_idx], y_train[val_idx]
        vol_va = vol_train[val_idx]

        for name, estimator in models.items():
            m = clone(estimator)
            m.fit(X_train[tr_idx], y_tr)
            p_va = m.predict(X_train[val_idx])
            metrics = compute_regression_metrics(y_va, p_va, len(full_cols), vol_va)
            cv_scores[name].append(metrics)

    cv_summary = {}
    print(f"\n{'Model':18s} | {'Mean MAE':10s} | {'RMSE':10s} | {'R2':7s} | {'Adj R2':8s} | {'Hit Sig':9s} | {'Rank IC':8s}")
    print("-" * 85)

    for name, fold_list in cv_scores.items():
        avg_mae = np.mean([f["mae_pct"] for f in fold_list])
        avg_rmse = np.mean([f["rmse_pct"] for f in fold_list])
        avg_r2 = np.mean([f["r2"] for f in fold_list])
        avg_adj_r2 = np.mean([f["adj_r2"] for f in fold_list])
        avg_hit_sig = np.mean([f["hit_ratio_sig"] for f in fold_list])
        avg_ic = np.mean([f["rank_ic"] for f in fold_list])

        cv_summary[name] = {
            "mae_pct": round(float(avg_mae), 4),
            "rmse_pct": round(float(avg_rmse), 4),
            "r2": round(float(avg_r2), 4),
            "adj_r2": round(float(avg_adj_r2), 4),
            "hit_ratio_sig": round(float(avg_hit_sig), 2),
            "rank_ic": round(float(avg_ic), 4),
        }
        print(f"{name:18s} | {avg_mae:.4f}%    | {avg_rmse:.4f}%   | {avg_r2:+.4f} | {avg_adj_r2:+.4f}  | {avg_hit_sig:.2f}%    | {avg_ic:+.4f}")

    # Retrain on full Train+Val set
    trained_models = {}
    for name, estimator in models.items():
        m = clone(estimator)
        m.fit(X_train, y_train)
        trained_models[name] = m

    # Champion is selected by cross-validation, never hardcoded.
    champion_name = select_champion(cv_summary, selection_metric)
    selection_method = f"cv_mean_{selection_metric}"

    # Fair baseline: best model that is NOT the champion, trained on the
    # baseline (macro-only) feature set so the comparison stays honest.
    baseline_candidates = [name for name in cv_summary if name != champion_name]
    baseline_name = max(baseline_candidates, key=lambda n: cv_summary[n]["rank_ic"])
    baseline_model = clone(models[baseline_name])
    baseline_model.fit(train_val_df[base_cols].values, y_train)

    champion_bundle = {
        "champion_name": champion_name,
        "selection_method": selection_method,
        "selection_metric": selection_metric,
        "champion_model": trained_models[champion_name],
        "model": trained_models[champion_name],
        "champion_feature_cols": full_cols,
        "feature_cols": full_cols,
        "baseline_name": baseline_name,
        "baseline_model": baseline_model,
        "baseline_feature_cols": base_cols,
        "target_col": target_col,
        "trained_models": trained_models,
        "cv_summary": cv_summary,
        "seed": seed,
        "feature_nan_imputed": feature_nan_imputed,
    }

    champion_path = os.path.join(output_model_dir, "champion_fair_model.joblib")
    joblib.dump(champion_bundle, champion_path)
    print(f"\n[Train] Champion ({selection_method}): {champion_name}")
    print(f"[Train] Fair baseline: {baseline_name} (trained on {len(base_cols)} baseline features)")
    print(f"[Train] Champion model saved to: {champion_path}")

    return cv_summary


if __name__ == "__main__":
    train_models()
