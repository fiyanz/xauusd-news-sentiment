"""Honest statistical significance reporting for model evaluation.

This module is the single source of truth for the significance contract in
``.hermes/plans/plan-perbaikan-f1-f4.md`` (section 3.4).  It computes:

* two-sided binomial test of the directional hit ratio against a 50% coin,
* Wilson score confidence interval for the hit ratio,
* Spearman rank IC with its p-value,
* Pesaran-Timmermann (1992) non-parametric directional test,
* a shuffled-label negative control for the rank IC,

and writes ``reports/significance.json``.

``sentiment_adds_value`` is *derived* from the p-values
(``rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05``) -- it is never hardcoded.
"""

import json
import os
from datetime import datetime, timedelta, timezone

import joblib
import numpy as np
import pandas as pd
from scipy.stats import binomtest, norm, spearmanr

SIGNIFICANCE_BASIS = "rank_ic_pvalue < 0.05 or hit_ratio_pvalue < 0.05"
DEFAULT_PROVENANCE_PATH = "data/processed/provenance.json"
DEFAULT_OUTPUT_PATH = "reports/significance.json"


# --------------------------------------------------------------------------- #
# Statistical primitives
# --------------------------------------------------------------------------- #
def wilson_ci(k: int, n: int, z: float = 1.96) -> tuple:
    """Wilson score interval for a binomial proportion.

    Returns ``(low, high)`` as fractions in ``[0, 1]``; ``(None, None)`` when
    ``n <= 0`` so callers can serialise ``null`` instead of NaN.
    """
    if n is None or n <= 0:
        return (None, None)
    k = int(k)
    n = int(n)
    p = k / n
    denom = 1.0 + z**2 / n
    center = (p + z**2 / (2 * n)) / denom
    margin = z * np.sqrt(p * (1 - p) / n + z**2 / (4 * n**2)) / denom
    return (float(max(0.0, center - margin)), float(min(1.0, center + margin)))


def binomtest_pvalue(k: int, n: int, p0: float = 0.5):
    """Two-sided binomial test of ``k`` successes in ``n`` trials against ``p0``."""
    if n is None or n <= 0:
        return None
    return float(binomtest(int(k), int(n), p0, alternative="two-sided").pvalue)


def spearman_rank_ic(y_true: np.ndarray, y_pred: np.ndarray) -> tuple:
    """Spearman rank IC and its p-value; degenerate input maps to ``(0.0, 1.0)``."""
    ic, pval = spearmanr(y_pred, y_true)
    if np.isnan(ic):
        return 0.0, 1.0
    return float(ic), float(pval)


def pesaran_timmermann_test(y_true: np.ndarray, y_pred: np.ndarray) -> tuple:
    """Pesaran-Timmermann (1992) non-parametric test of directional accuracy.

    The original implementation lived in ``evaluate_fair.py``; it is re-exported
    from there for backwards compatibility.
    """
    y_sign = (np.asarray(y_true) > 0).astype(int)
    y_hat_sign = (np.asarray(y_pred) > 0).astype(int)
    n = len(y_true)

    p_hat = np.mean(y_sign == y_hat_sign)
    p_y = np.mean(y_sign)
    p_yhat = np.mean(y_hat_sign)
    p_star = p_y * p_yhat + (1 - p_y) * (1 - p_yhat)

    v_p = (p_star * (1 - p_star)) / n
    v_star = (
        (2 * p_y - 1) ** 2 * (p_yhat * (1 - p_yhat)) / n
        + (2 * p_yhat - 1) ** 2 * (p_y * (1 - p_y)) / n
        + 4 * (p_y * (1 - p_y) * p_yhat * (1 - p_yhat)) / (n**2)
    )

    denom = np.sqrt(max(v_p - v_star, 1e-12))
    pt_stat = (p_hat - p_star) / denom
    p_val = 1 - norm.cdf(pt_stat)
    return float(pt_stat), float(p_val)


def negative_control_ic(y_true: np.ndarray, y_pred: np.ndarray, seed: int = 42) -> float:
    """Rank IC against a shuffled copy of the labels (should be ~0)."""
    rng = np.random.default_rng(seed)
    ic, _ = spearmanr(y_pred, rng.permutation(np.asarray(y_true)))
    if np.isnan(ic):
        return 0.0
    return float(ic)


def sentiment_adds_value_from_pvalues(rank_ic_pvalue, hit_ratio_pvalue, alpha: float = 0.05) -> bool:
    """Derive ``sentiment_adds_value`` from significance, never hardcode it."""
    if rank_ic_pvalue is None and hit_ratio_pvalue is None:
        return False
    rank_sig = rank_ic_pvalue is not None and rank_ic_pvalue < alpha
    hit_sig = hit_ratio_pvalue is not None and hit_ratio_pvalue < alpha
    return bool(rank_sig or hit_sig)


# --------------------------------------------------------------------------- #
# Champion selection (mirrors ``src.models.train.select_champion``)
# --------------------------------------------------------------------------- #
def select_champion_from_cv(cv_summary: dict, selection_method: str = "cv_mean_rank_ic") -> str:
    """Return the model with the best mean CV metric.

    ``selection_method`` must be ``cv_mean_rank_ic`` or ``cv_mean_hit_sig``.
    """
    metric = "hit_ratio_sig" if selection_method == "cv_mean_hit_sig" else "rank_ic"
    if metric not in ("rank_ic", "hit_ratio_sig"):
        raise ValueError(f"Unsupported selection_method: {selection_method}")
    valid = {name: scores for name, scores in cv_summary.items() if metric in scores}
    if not valid:
        raise ValueError(f"cv_summary has no '{metric}' entries")
    return max(valid, key=lambda name: valid[name][metric])


# --------------------------------------------------------------------------- #
# Artifact provenance gate
# --------------------------------------------------------------------------- #
def check_artifact(features_parquet: str, provenance_path: str = DEFAULT_PROVENANCE_PATH) -> dict:
    """Classify the feature artifact as verified / stale / legacy_synthetic.

    A artifact is ``verified`` only when ``provenance.json`` exists, its
    ``generated_at`` is recent (same session, < 24h) *and* the parquet carries
    the ``data_source`` / ``generated_at`` columns required by the plan.
    """
    info = {
        "artifact_status": "unverified",
        "is_simulated": None,
        "generated_at": None,
        "reason": "",
    }

    if not os.path.exists(provenance_path):
        info.update(
            artifact_status="legacy_synthetic",
            is_simulated=True,
            reason=(
                "provenance.json tidak ditemukan; artifact berasal dari data sintetis "
                "(F1 belum selesai diregenerasi). Retrain ditunda ke tahap integrasi."
            ),
        )
        return info

    try:
        with open(provenance_path, "r") as f:
            prov = json.load(f)
    except Exception as exc:  # noqa: BLE001 - report, don't crash
        info.update(
            artifact_status="unverified",
            is_simulated=None,
            reason=f"provenance.json tidak dapat dibaca: {exc}",
        )
        return info

    generated_at = prov.get("generated_at")
    info["generated_at"] = generated_at

    parquet_generated_at = None
    has_provenance_columns = False
    try:
        import pyarrow.parquet as pq

        cols = pq.ParquetFile(features_parquet).schema.names
        has_provenance_columns = "data_source" in cols and "generated_at" in cols
        if "generated_at" in cols:
            import pyarrow.compute as pc

            table = pq.read_table(features_parquet, columns=["generated_at"])
            values = pc.drop_null(table.column("generated_at")).to_pylist()
            if values:
                parquet_generated_at = values[0]
    except Exception:  # noqa: BLE001
        has_provenance_columns = False

    fresh = False
    if generated_at:
        try:
            gt = datetime.fromisoformat(str(generated_at).replace("Z", "+00:00"))
            if gt.tzinfo is None:
                gt = gt.replace(tzinfo=timezone.utc)
            fresh = (datetime.now(timezone.utc) - gt) <= timedelta(hours=24)
        except Exception:  # noqa: BLE001
            fresh = False

    # A parquet newer than provenance.json means the pipeline is still writing.
    inconsistent = False
    if generated_at and parquet_generated_at:
        try:
            prov_dt = datetime.fromisoformat(str(generated_at).replace("Z", "+00:00"))
            pq_dt = datetime.fromisoformat(str(parquet_generated_at).replace("Z", "+00:00"))
            if prov_dt.tzinfo is None:
                prov_dt = prov_dt.replace(tzinfo=timezone.utc)
            if pq_dt.tzinfo is None:
                pq_dt = pq_dt.replace(tzinfo=timezone.utc)
            inconsistent = pq_dt > prov_dt + timedelta(seconds=60)
        except Exception:  # noqa: BLE001
            inconsistent = False

    if inconsistent:
        info.update(
            artifact_status="inconsistent",
            is_simulated=None,
            reason=(
                "parquet generated_at lebih baru dari provenance.json; "
                "artifact sedang diregenerasi. Retrain ditunda hingga provenance konsisten."
            ),
        )
    elif has_provenance_columns and fresh:
        info.update(
            artifact_status="verified",
            is_simulated=False,
            reason="provenance.json ditemukan, generated_at baru, dan kolom data_source/generated_at ada.",
        )
    elif has_provenance_columns:
        info.update(
            artifact_status="stale",
            is_simulated=False,
            reason="Kolom provenance ada tetapi generated_at tidak baru (>24 jam).",
        )
    else:
        info.update(
            artifact_status="legacy_synthetic",
            is_simulated=True,
            reason="provenance.json ada tetapi parquet tidak memiliki kolom data_source/generated_at.",
        )
    return info


# --------------------------------------------------------------------------- #
# Report builder
# --------------------------------------------------------------------------- #
def compute_significance(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    vol: np.ndarray,
    champion_name: str,
    selection_method: str,
    seed: int = 42,
) -> dict:
    """Compute the full significance contract for one model's test predictions."""
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    vol = np.asarray(vol, dtype=float)

    sig_mask = np.abs(y_true) > (0.5 * vol)
    n_sig = int(sig_mask.sum())
    if n_sig > 0:
        hits = int(np.sum(np.sign(y_pred[sig_mask]) == np.sign(y_true[sig_mask])))
        hit_ratio_sig = hits / n_sig
        ci_low, ci_high = wilson_ci(hits, n_sig)
        hit_pvalue = binomtest_pvalue(hits, n_sig)
    else:
        hits = 0
        hit_ratio_sig = None
        ci_low = ci_high = None
        hit_pvalue = None

    rank_ic, rank_pvalue = spearman_rank_ic(y_true, y_pred)
    pt_stat, pt_pvalue = pesaran_timmermann_test(y_true, y_pred)
    neg_ic = negative_control_ic(y_true, y_pred, seed=seed)

    return {
        "champion_name": champion_name,
        "selection_method": selection_method,
        "test_samples": int(len(y_true)),
        "hit_ratio_sig": None if hit_ratio_sig is None else round(float(hit_ratio_sig), 4),
        "hit_ratio_ci95": [
            None if ci_low is None else round(float(ci_low), 4),
            None if ci_high is None else round(float(ci_high), 4),
        ],
        "hit_ratio_pvalue": None if hit_pvalue is None else round(float(hit_pvalue), 5),
        "rank_ic": round(float(rank_ic), 4),
        "rank_ic_pvalue": round(float(rank_pvalue), 5),
        "pesaran_timmermann_stat": round(float(pt_stat), 4),
        "pesaran_timmermann_pvalue": round(float(pt_pvalue), 5),
        "negative_control_ic": round(float(neg_ic), 4),
        "sentiment_adds_value": sentiment_adds_value_from_pvalues(rank_pvalue, hit_pvalue),
        "sentiment_adds_value_basis": SIGNIFICANCE_BASIS,
        # --- supporting detail (not part of the locked contract) -------------
        "hit_ratio_sig_n": n_sig,
        "hit_ratio_sig_hits": hits,
        "alpha": 0.05,
    }


def _model_test_metrics(test_df: pd.DataFrame, bundle: dict, name: str) -> dict:
    """Compute per-model test metrics for the supporting ``models`` block.

    Models that cannot score the artifact (e.g. estimators that reject NaN
    features) are skipped rather than aborting the whole report.
    """
    model = bundle.get("trained_models", {}).get(name)
    if model is None:
        return {}
    feature_cols = bundle["champion_feature_cols"]
    try:
        X = test_df[feature_cols].fillna(0.0).values
        preds = model.predict(X)
    except Exception as exc:  # noqa: BLE001 - report the gap, don't crash
        return {"error": f"{type(exc).__name__}: {exc}"}
    y = test_df[bundle["target_col"]].values
    vol = test_df["vol_pre"].values
    sig_mask = np.abs(y) > (0.5 * vol)
    rank_ic, rank_p = spearman_rank_ic(y, preds)
    if sig_mask.sum() > 0:
        hits = int(np.sum(np.sign(preds[sig_mask]) == np.sign(y[sig_mask])))
        hit = hits / int(sig_mask.sum())
        ci = wilson_ci(hits, int(sig_mask.sum()))
        hit_p = binomtest_pvalue(hits, int(sig_mask.sum()))
    else:
        hit, ci, hit_p = None, (None, None), None
    return {
        "rank_ic": round(rank_ic, 4),
        "rank_ic_pvalue": round(rank_p, 5),
        "hit_ratio_sig": None if hit is None else round(hit, 4),
        "hit_ratio_ci95": [None if ci[0] is None else round(ci[0], 4), None if ci[1] is None else round(ci[1], 4)],
        "hit_ratio_pvalue": None if hit_p is None else round(hit_p, 5),
    }


def build_significance_report(
    features_parquet: str = "data/processed/bucketed_features.parquet",
    model_bundle_path: str = "models/champion_fair_model.joblib",
    output_path: str = DEFAULT_OUTPUT_PATH,
    provenance_path: str = DEFAULT_PROVENANCE_PATH,
    seed: int = 42,
) -> dict:
    """Evaluate the CV-selected champion on the untouched test split and write the report."""
    bundle = joblib.load(model_bundle_path)
    cv_summary = bundle.get("cv_summary", {}) or {}
    selection_method = bundle.get("selection_method") or "cv_mean_rank_ic"
    if selection_method not in ("cv_mean_rank_ic", "cv_mean_hit_sig"):
        selection_method = "cv_mean_rank_ic"

    if cv_summary:
        try:
            champion_name = select_champion_from_cv(cv_summary, selection_method)
        except ValueError:
            # Bundles without a rank_ic/hit_ratio_sig CV summary (e.g. produced by
            # train_fair_comparison.py) fall back to the bundle's own champion.
            champion_name = bundle.get("champion_name", "Random_Forest")
    else:
        champion_name = bundle.get("champion_name", "Random_Forest")

    df = pd.read_parquet(features_parquet)
    test_df = df[df["split"] == "test"].reset_index(drop=True)

    trained_models = bundle.get("trained_models", {})
    if champion_name in trained_models:
        model = trained_models[champion_name]
    else:
        model = bundle["champion_model"]

    feature_cols = bundle["champion_feature_cols"]
    X_test = test_df[feature_cols].fillna(0.0).values
    y_test = test_df[bundle["target_col"]].values
    vol_test = test_df["vol_pre"].values
    try:
        preds = model.predict(X_test)
    except Exception as exc:  # noqa: BLE001 - surface a clear, actionable error
        raise RuntimeError(
            f"Champion model {champion_name!r} cannot score the artifact "
            f"(possibly NaN features): {type(exc).__name__}: {exc}"
        ) from exc

    report = compute_significance(
        y_test,
        preds,
        vol_test,
        champion_name=champion_name,
        selection_method=selection_method,
        seed=seed,
    )

    artifact = check_artifact(features_parquet, provenance_path)
    report["artifact_status"] = artifact["artifact_status"]
    report["is_simulated"] = artifact["is_simulated"]
    report["artifact_reason"] = artifact["reason"]
    report["bundle_champion_name"] = bundle.get("champion_name")
    report["cv_summary"] = cv_summary
    report["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    report["models"] = {
        name: _model_test_metrics(test_df, bundle, name) for name in trained_models
    }
    if artifact["artifact_status"] != "verified":
        report["disclaimer"] = (
            "Metrik pada file ini dihitung pada artifact legacy (data sintetis). "
            "Retrain ditunda hingga provenance F1 terverifikasi. "
            "Angka ini DIAGNOSTIK, bukan hasil akhir."
        )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"[Significance] Champion (by {selection_method}): {champion_name}")
    print(
        f"[Significance] rank_ic={report['rank_ic']:+.4f} (p={report['rank_ic_pvalue']}), "
        f"hit_ratio_sig={report['hit_ratio_sig']} "
        f"(p={report['hit_ratio_pvalue']}, CI95={report['hit_ratio_ci95']})"
    )
    print(f"[Significance] sentiment_adds_value={report['sentiment_adds_value']}")
    print(f"[Significance] artifact_status={report['artifact_status']}")
    print(f"[Significance] Report saved to: {output_path}")
    return report


def load_significance_report(path: str = DEFAULT_OUTPUT_PATH) -> dict:
    """Load ``reports/significance.json``; returns ``{}`` when absent."""
    if not os.path.exists(path):
        return {}
    with open(path, "r") as f:
        return json.load(f)


if __name__ == "__main__":
    build_significance_report()
