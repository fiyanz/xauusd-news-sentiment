"""Multi-Model Training Engine (Random Forest, LightGBM, XGBoost, Ridge).

Includes 5-Fold Walk-Forward Cross Validation and computes MAE, MSE, RMSE, MAPE, R2, and Adjusted R2.

Feature preprocessing (``src.features.reduce``):
- Correlated blocks (macro, topic, sentiment x topic, tfidf) are compressed with
  PCA fitted on the training data only, so every original feature still
  contributes through its component (no feature is dropped).
- Time features are encoded cyclically (sin/cos).
- TF-IDF, previously computed but unused, now enters the model via text PCs.
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

from src.features.reduce import FeatureReducer


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

    y_all = train_val_df[target_col].values
    vol_all = train_val_df["vol_pre"].values

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

    # Walk-Forward Cross Validation. The reducer (scaler + PCA) is refit on each
    # fold's training portion only, so validation/test rows never influence the
    # component basis (anti look-ahead).
    tscv = TimeSeriesSplit(n_splits=n_splits)
    cv_scores = {name: [] for name in models}

    print(f"\n--- Running {n_splits}-Fold Walk-Forward Cross Validation ---")
    for tr_idx, val_idx in tscv.split(train_val_df):
        fold_reducer = FeatureReducer().fit(train_val_df.iloc[tr_idx])
        X_tr = fold_reducer.transform(train_val_df.iloc[tr_idx]).to_numpy(dtype=float)
        X_va = fold_reducer.transform(train_val_df.iloc[val_idx]).to_numpy(dtype=float)
        y_tr, y_va = y_all[tr_idx], y_all[val_idx]
        vol_va = vol_all[val_idx]

        for name, estimator in models.items():
            m = clone(estimator)
            m.fit(X_tr, y_tr)
            p_va = m.predict(X_va)
            metrics = compute_regression_metrics(y_va, p_va, len(fold_reducer.feature_cols), vol_va)
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

    # Final reducer fitted on Train+Val; all production models use it.
    reducer = FeatureReducer().fit(train_val_df)
    X_train = reducer.transform(train_val_df).to_numpy(dtype=float)

    # Retrain on full Train+Val set
    trained_models = {}
    for name, estimator in models.items():
        m = clone(estimator)
        m.fit(X_train, y_all)
        trained_models[name] = m

    # Champion is selected by cross-validation, never hardcoded.
    champion_name = select_champion(cv_summary, selection_metric)
    selection_method = f"cv_mean_{selection_metric}"

    # Fair baseline: best model that is NOT the champion, trained on the
    # baseline (event + macro block) feature set so the comparison stays honest.
    baseline_candidates = [name for name in cv_summary if name != champion_name]
    baseline_name = max(baseline_candidates, key=lambda n: cv_summary[n]["rank_ic"])
    baseline_cols = reducer.base_cols + reducer.block_columns("macro")
    baseline_model = clone(models[baseline_name])
    baseline_model.fit(reducer.transform(train_val_df)[baseline_cols].to_numpy(dtype=float), y_all)

    # Missing raw feature values (e.g. surprise NaN when no macro release overlaps
    # the news window) are imputed with 0.0 by the reducer — the neutral encoding
    # for "no event" — and the imputation count is recorded in the bundle.
    raw_cols = [c for c in reducer.raw_columns() if c in train_val_df.columns]
    feature_nan_imputed = int(train_val_df[raw_cols].isna().sum().sum())

    champion_bundle = {
        "champion_name": champion_name,
        "selection_method": selection_method,
        "selection_metric": selection_metric,
        "champion_model": trained_models[champion_name],
        "model": trained_models[champion_name],
        "champion_feature_cols": reducer.feature_cols,
        "feature_cols": reducer.feature_cols,
        "reducer": reducer,
        "block_explained_variance": reducer.explained_variance(),
        # Blok embedding (precomputed): metadata reducer yang difit pada train
        # saja, dipakai laporan untuk membuktikan anti look-ahead.
        "embedding_block": reducer.blocks.get("embedding"),
        "raw_feature_count": len(raw_cols),
        "baseline_name": baseline_name,
        "baseline_model": baseline_model,
        "baseline_feature_cols": baseline_cols,
        "target_col": target_col,
        "trained_models": trained_models,
        "cv_summary": cv_summary,
        "seed": seed,
        "feature_nan_imputed": feature_nan_imputed,
    }

    champion_path = os.path.join(output_model_dir, "champion_fair_model.joblib")
    joblib.dump(champion_bundle, champion_path)
    print(f"\n[Train] Champion ({selection_method}): {champion_name}")
    print(f"[Train] Fitur: {len(reducer.feature_cols)} dari {len(raw_cols)} mentah "
          f"(PCA blok: {reducer.explained_variance()})")
    print(f"[Train] Fair baseline: {baseline_name} (trained on {len(baseline_cols)} baseline features)")
    print(f"[Train] Champion model saved to: {champion_path}")

    return cv_summary


if __name__ == "__main__":
    train_models()
