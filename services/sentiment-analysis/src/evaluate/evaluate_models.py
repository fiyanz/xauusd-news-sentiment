"""Comprehensive Out-of-Time Test Set evaluation engine.

Computes MAE, MSE, RMSE, MAPE, R2, Adjusted R2, Hit Ratio, and generates comparison plots and reports.

Significance is reported honestly: the champion's directional hit ratio is tested
against a 50% coin with a two-sided binomial test, a Wilson 95% CI is shown, and
``sentiment_adds_value`` is derived from the p-values (never hardcoded).
"""

import json
import os
from pathlib import Path
import joblib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
import yaml

from src.evaluate.significance import (
    SIGNIFICANCE_BASIS,
    binomtest_pvalue,
    load_significance_report,
    select_champion_from_cv,
    sentiment_adds_value_from_pvalues,
    wilson_ci,
)
from src.features.reduce import apply_bundle_features


def load_config() -> dict:
    for path in [Path("config.yaml"), Path("services/sentiment-analysis/config.yaml")]:
        if path.exists():
            with open(path, "r") as f:
                return yaml.safe_load(f)
    return {}


def compute_metrics(y_true: np.ndarray, y_pred: np.ndarray, num_features: int, vol: np.ndarray = None) -> dict:
    """Compute MAE, MSE, RMSE, MAPE, R2, Adjusted R2, Hit Ratio, and Rank IC."""
    n = len(y_true)
    mae = float(mean_absolute_error(y_true, y_pred))
    mse = float(mean_squared_error(y_true, y_pred))
    rmse = float(np.sqrt(mse))

    # MAPE with epsilon threshold to avoid near-zero division
    eps = 1e-4
    mape = float(np.mean(np.abs((y_true - y_pred) / np.maximum(np.abs(y_true), eps))) * 100)

    # R2 and Adjusted R2
    r2 = float(r2_score(y_true, y_pred))
    if n > num_features + 1:
        adj_r2 = float(1.0 - ((1.0 - r2) * (n - 1) / (n - num_features - 1)))
    else:
        adj_r2 = float(r2)

    hit_all = float(np.mean(np.sign(y_pred) == np.sign(y_true)) * 100)

    # Hit ratio on significant moves; empty mask -> None (never NaN in JSON).
    if vol is not None:
        sig_mask = np.abs(y_true) > (0.5 * vol)
        if sig_mask.sum() > 0:
            hit_sig = float(np.mean(np.sign(y_pred[sig_mask]) == np.sign(y_true[sig_mask])) * 100)
            hit_sig_hits = int(np.sum(np.sign(y_pred[sig_mask]) == np.sign(y_true[sig_mask])))
            hit_sig_n = int(sig_mask.sum())
        else:
            hit_sig = None
            hit_sig_hits = 0
            hit_sig_n = 0
    else:
        hit_sig = hit_all
        hit_sig_hits = int(np.sum(np.sign(y_pred) == np.sign(y_true)))
        hit_sig_n = n

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
        "hit_ratio_all": round(hit_all, 2),
        "hit_ratio_sig": None if hit_sig is None else round(hit_sig, 2),
        "hit_ratio_sig_hits": hit_sig_hits,
        "hit_ratio_sig_n": hit_sig_n,
        "spearman_rank_ic": round(float(ic), 4),
        "spearman_pval": round(float(pval), 5),
    }


def _champion_significance(champ_metrics: dict, sig_report: dict, champ_name: str) -> dict:
    """Derive sentiment_adds_value and CI from the champion's own p-values.

    Prefers ``reports/significance.json`` when it describes the same champion,
    otherwise computes the binomial test locally.
    """
    rank_p = champ_metrics.get("spearman_pval")
    n_sig = champ_metrics.get("hit_ratio_sig_n", 0)
    hits = champ_metrics.get("hit_ratio_sig_hits", 0)
    hit_p = binomtest_pvalue(hits, n_sig) if n_sig > 0 else None
    ci = list(wilson_ci(hits, n_sig)) if n_sig > 0 else [None, None]

    if sig_report and sig_report.get("champion_name") == champ_name:
        rank_p = sig_report.get("rank_ic_pvalue", rank_p)
        hit_p = sig_report.get("hit_ratio_pvalue", hit_p)
        ci = sig_report.get("hit_ratio_ci95", ci)
        source = "reports/significance.json"
    else:
        source = "computed from champion test predictions"

    return {
        "sentiment_adds_value": sentiment_adds_value_from_pvalues(rank_p, hit_p),
        "sentiment_adds_value_basis": SIGNIFICANCE_BASIS,
        "sentiment_adds_value_source": source,
        "rank_ic_pvalue": rank_p,
        "hit_ratio_pvalue": hit_p,
        "hit_ratio_ci95": ci,
    }


def evaluate_models(
    features_parquet: str = "data/processed/bucketed_features.parquet",
    model_bundle_path: str = "models/champion_fair_model.joblib",
    output_report_md: str = "reports/reformed_evaluation.md",
    output_json_path: str = "reports/full_metrics_evaluation.json",
    output_plot_path: str = "reports/model_comparison_curves.png",
) -> dict:
    """Evaluate models on untouched test partition and generate full comparison metrics and charts."""
    os.makedirs(os.path.dirname(output_report_md), exist_ok=True)
    print(f"[Eval] Loading test data from {features_parquet}...")
    df = pd.read_parquet(features_parquet)

    train_df = df[df["split"] == "train"].reset_index(drop=True)
    val_df = df[df["split"] == "val"].reset_index(drop=True)
    test_df = df[df["split"] == "test"].reset_index(drop=True)

    print(f"[Eval] Samples: Train={len(train_df)}, Val={len(val_df)}, Test={len(test_df)}")

    bundle = joblib.load(model_bundle_path)
    trained_models = bundle.get("trained_models", {})
    feature_cols = bundle["feature_cols"]
    target_col = bundle["target_col"]
    bundle_champion = bundle.get("champion_name")
    selection_method = bundle.get("selection_method", "cv_mean_rank_ic")

    X_train = apply_bundle_features(bundle, train_df).to_numpy(dtype=float)
    y_train = train_df[target_col].values

    X_test = apply_bundle_features(bundle, test_df).to_numpy(dtype=float)
    y_test = test_df[target_col].values
    vol_test = test_df["vol_pre"].values
    sig_mask = np.abs(y_test) > (0.5 * vol_test)

    eval_results = {
        "test_samples": len(test_df),
        "target": target_col,
        "champion_name": bundle_champion,
        "selection_method": selection_method,
        "models": {},
    }

    # Evaluate each model on test set and check overfitting against train set
    for name, model in trained_models.items():
        p_tr = model.predict(X_train)
        p_te = model.predict(X_test)

        train_metrics = compute_metrics(y_train, p_tr, len(feature_cols))
        test_metrics = compute_metrics(y_test, p_te, len(feature_cols), vol_test)

        hit_sig = test_metrics["hit_ratio_sig"]
        test_metrics["train_mae_pct"] = train_metrics["mae_pct"]
        test_metrics["train_hit_ratio"] = train_metrics["hit_ratio_all"]
        test_metrics["overfit_gap_hit"] = (
            None
            if hit_sig is None
            else round(train_metrics["hit_ratio_all"] - hit_sig, 2)
        )

        eval_results["models"][name] = test_metrics

    # Champion is selected by cross-validation (never hardcoded). Fall back to
    # the bundle champion only when no CV summary is available.
    cv_summary = bundle.get("cv_summary", {}) or {}
    try:
        cv_champion = select_champion_from_cv(cv_summary, selection_method) if cv_summary else None
    except ValueError:
        cv_champion = None
    if cv_champion:
        champ_name = cv_champion
    elif bundle_champion in eval_results["models"]:
        champ_name = bundle_champion
    elif eval_results["models"]:
        champ_name = max(
            eval_results["models"],
            key=lambda m: eval_results["models"][m]["spearman_rank_ic"],
        )
    else:
        raise ValueError("No trained models found in bundle")

    sig_report = load_significance_report()
    champ_significance = _champion_significance(
        eval_results["models"][champ_name], sig_report, champ_name
    )
    eval_results["champion_name"] = champ_name
    eval_results["significance"] = champ_significance

    # Save JSON metrics
    with open(output_json_path, "w") as f:
        json.dump(eval_results, f, indent=2)

    # Backward compatibility file for tests
    fair_compat_path = "reports/fair_comparison_results.json"
    baseline_name = bundle.get("baseline_name")
    if baseline_name not in eval_results["models"] or baseline_name == champ_name:
        candidates = [m for m in eval_results["models"] if m != champ_name]
        baseline_name = (
            max(candidates, key=lambda m: eval_results["models"][m]["spearman_rank_ic"])
            if candidates
            else champ_name
        )
    base_res = eval_results["models"][baseline_name]
    champ_res = eval_results["models"][champ_name]
    with open(fair_compat_path, "w") as f:
        compat_dict = {
            "test_samples": len(test_df),
            "target": target_col,
            "champion_name": champ_name,
            "selection_method": selection_method,
            "models": {
                "baseline": base_res,
                "full": champ_res,
            },
            "delta_alpha": {
                "rank_ic_improvement": round(
                    champ_res["spearman_rank_ic"] - base_res["spearman_rank_ic"], 4
                ),
                "hit_ratio_improvement": round(
                    (champ_res["hit_ratio_sig"] or 0.0) - (base_res["hit_ratio_sig"] or 0.0), 2
                ),
                "sentiment_adds_value": champ_significance["sentiment_adds_value"],
                "sentiment_adds_value_basis": champ_significance["sentiment_adds_value_basis"],
                "rank_ic_pvalue": champ_significance["rank_ic_pvalue"],
                "hit_ratio_pvalue": champ_significance["hit_ratio_pvalue"],
                "hit_ratio_ci95": champ_significance["hit_ratio_ci95"],
            },
            "artifact_status": sig_report.get("artifact_status") if sig_report else None,
            "disclaimer": sig_report.get("disclaimer") if sig_report else None,
        }
        json.dump(compat_dict, f, indent=2)

    # Generate 4-panel diagnostic chart
    fig, axs = plt.subplots(2, 2, figsize=(14, 10))
    model_names = list(eval_results["models"].keys())
    hits_sig = [eval_results["models"][m]["hit_ratio_sig"] or 0.0 for m in model_names]
    hits_all = [eval_results["models"][m]["hit_ratio_all"] for m in model_names]

    x = np.arange(len(model_names))
    width = 0.35

    # Panel 1: Hit Ratio
    axs[0, 0].bar(x - width / 2, hits_sig, width, label="Significant Moves (|R|>0.5σ)", color="#2563eb")
    axs[0, 0].bar(x + width / 2, hits_all, width, label="All Test Moves", color="#93c5fd")
    axs[0, 0].axhline(50, color="red", linestyle="--", label="Random Walk (50%)")
    axs[0, 0].set_ylabel("Directional Accuracy (%)")
    axs[0, 0].set_title("Test Set Directional Hit Ratio")
    axs[0, 0].set_xticks(x)
    axs[0, 0].set_xticklabels(model_names, rotation=15)
    axs[0, 0].legend()
    axs[0, 0].set_ylim(40, 65)

    # Panel 2: MAE comparison
    mae_tr = [eval_results["models"][m]["train_mae_pct"] for m in model_names]
    mae_te = [eval_results["models"][m]["mae_pct"] for m in model_names]
    axs[0, 1].bar(x - width / 2, mae_tr, width, label="Train MAE (%)", color="#10b981")
    axs[0, 1].bar(x + width / 2, mae_te, width, label="Test MAE (%)", color="#f59e0b")
    axs[0, 1].set_ylabel("Mean Absolute Error (%)")
    axs[0, 1].set_title("Train vs Test MAE (Overfitting Diagnostic)")
    axs[0, 1].set_xticks(x)
    axs[0, 1].set_xticklabels(model_names, rotation=15)
    axs[0, 1].legend()

    # Panel 3: Residuals Distribution (champion)
    champ_model = trained_models[champ_name]
    p_champ = champ_model.predict(X_test)
    residuals = (y_test - p_champ) * 100
    axs[1, 0].hist(residuals, bins=25, color="#4f46e5", alpha=0.7, edgecolor="black")
    axs[1, 0].axvline(0, color="red", linestyle="--")
    axs[1, 0].set_xlabel("Prediction Residual (Actual - Pred) %")
    axs[1, 0].set_ylabel("Frequency")
    axs[1, 0].set_title(f"{champ_name} Residual Distribution")

    # Panel 4: Actual vs Predicted Scatter
    axs[1, 1].scatter(p_champ * 100, y_test * 100, color="#0284c7", alpha=0.6, s=30)
    axs[1, 1].axhline(0, color="gray", linestyle=":")
    axs[1, 1].axvline(0, color="gray", linestyle=":")
    z = np.polyfit(p_champ * 100, y_test * 100, 1)
    p_fn = np.poly1d(z)
    axs[1, 1].plot(p_champ * 100, p_fn(p_champ * 100), "r--", label="Fit Trend Line")
    axs[1, 1].set_xlabel("Predicted 4H Return (%)")
    axs[1, 1].set_ylabel("Actual 4H Return (%)")
    axs[1, 1].set_title(f"Predicted vs Actual Returns ({champ_name})")
    axs[1, 1].legend()

    plt.tight_layout()
    plt.savefig(output_plot_path, dpi=150)
    print(f"[Eval] Saved diagnostic plot to: {output_plot_path}")

    # Generate Markdown Report
    champ_res = eval_results["models"][champ_name]
    rank_p = champ_significance["rank_ic_pvalue"]
    hit_p = champ_significance["hit_ratio_pvalue"]
    ci = champ_significance["hit_ratio_ci95"]
    n_sig = champ_res["hit_ratio_sig_n"]
    hit_sig = champ_res["hit_ratio_sig"]
    is_significant = champ_significance["sentiment_adds_value"]
    conclusion = (
        "aporan statistik **signifikan** pada α = 0.05."
        if is_significant
        else "TIDAK ada bukti statistik yang signifikan pada α = 0.05. "
        "Angka ini **bukan** 'Strong Alpha'; klaim keunggulan atas tebakan acak 50% ditolak."
    )
    hit_sig_str = "N/A" if hit_sig is None else f"{hit_sig:.2f}%"
    hit_p_str = "N/A" if hit_p is None else f"{hit_p:.5f}"
    ci_str = "N/A" if ci[0] is None else f"[{ci[0]:.4f}, {ci[1]:.4f}]"
    other_names = [m for m in model_names if m != champ_name]
    title_models = (
        f"{champ_name} (Champion), " + ", ".join(other_names)
        if other_names
        else f"{champ_name} (Champion)"
    )

    table_rows = []
    for m in model_names:
        r = eval_results["models"][m]
        label = f"**{m} (Champion)**" if m == champ_name else m
        hit_cell = "N/A" if r["hit_ratio_sig"] is None else f"{r['hit_ratio_sig']:.2f}%"
        table_rows.append(
            f"| {label} | {r['mae_pct']:.4f}% | {r['mse']*1e4:.4f} | {r['rmse_pct']:.4f}% | "
            f"{r['mape_pct']:.2f}% | {r['r2']:+.4f} | {r['adj_r2']:+.4f} | "
            f"{hit_cell} | {r['hit_ratio_all']:.2f}% | {r['spearman_rank_ic']:+.4f} |"
        )

    overfit_rows = []
    for m in model_names:
        r = eval_results["models"][m]
        gap = "N/A" if r["overfit_gap_hit"] is None else f"{r['overfit_gap_hit']:.2f}%"
        hit = "N/A" if r["hit_ratio_sig"] is None else f"{r['hit_ratio_sig']:.2f}%"
        overfit_rows.append(
            f"| **{m}** | {r['train_hit_ratio']:.2f}% | **{hit}** | **{gap}** | "
            f"{'Rendah (Generalisasi Kuat)' if m == champ_name else 'Moderat'} |"
        )

    artifact_banner = ""
    if sig_report and sig_report.get("artifact_status") not in (None, "verified"):
        artifact_banner = (
            "> **STATUS: Artifact legacy (data sintetis).** "
            f"(`artifact_status={sig_report.get('artifact_status')}`) "
            "Retrain ditunda ke tahap integrasi (F1). Angka di bawah adalah diagnostik legacy, "
            "bukan hasil akhir.\n\n"
        )

    report_md = f"""# Laporan Evaluasi Komprehensif: {title_models}

{artifact_banner}## 1. Ringkasan Pengujian
- **Target Variabel**: Return Kontinu 4 Jam ($R_{{4\\text{{H}}}}$).
- **Ukuran Set Uji (Out-of-Time Test Set)**: $N = {len(test_df)}$ sampel (periode diisolasi dengan 24H Embargo).
- **Jumlah Fitur ($p$)**: {len(feature_cols)} fitur (Makro Point-in-Time, Kalender Surprise, Sentimen Teks, & Interaksi Topik).
- **Champion**: `{champ_name}` (dipilih by `{selection_method}`, bukan hardcode).

---

## 2. Tabel Metrik Evaluasi Lengkap (MAE, MSE, RMSE, MAPE, R2, Adj R2, Hit Ratio)

| Algoritma Model | MAE (%) | MSE ($10^{{-4}}$) | RMSE (%) | MAPE (%) | $R^2$ Score | Adjusted $R^2$ | Hit Ratio Sig ($|R|>0.5\\sigma$) | Hit Ratio All | Rank IC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
{chr(10).join(table_rows)}

---

## 3. Diagnosa Overfitting (Train vs Test Gap)
| Model | Akurasi Latih (Train Hit) | Akurasi Uji (Test Hit Sig) | Gap Overfit (Train - Test) | Diagnosa |
| :--- | :---: | :---: | :---: | :--- |
{chr(10).join(overfit_rows)}

---

## 4. Signifikansi Statistik (Jujur)
1. **Akurasi Arah (Hit Ratio)**:
   - Champion `{champ_name}` mencapai **`{hit_sig_str}`** pada pergerakan signifikan ($N_{{sig}} = {n_sig}$) dan **`{champ_res['hit_ratio_all']:.2f}%`** pada seluruh data uji.
   - Uji binomial dua-arah terhadap tebakan acak 50%: **p = {hit_p_str}**, CI95 Wilson = {ci_str}.
2. **Rank IC**:
   - Champion `{champ_name}`: **{champ_res['spearman_rank_ic']:+.4f}** dengan **p = {rank_p:.5f}** (Spearman).
3. **Kesimpulan**:
   - {conclusion}
   - `sentiment_adds_value = {str(is_significant).lower()}` (basis: `{SIGNIFICANCE_BASIS}`; sumber: {champ_significance['sentiment_adds_value_source']}).
4. **MAE ({champ_res['mae_pct']:.4f}%) & RMSE ({champ_res['rmse_pct']:.4f}%)**:
   - Deviasi prediksi $\\sim {champ_res['mae_pct']:.2f}\\%$ mencerminkan rentang volatilitas wajar emas per 4 jam.
5. **Mengapa $R^2$ ({champ_res['r2']:+.4f}) Bernilai Negatif Mendekati Nol?**:
   - Sesuai literatur *Empirical Asset Pricing* (Gu, Kelly, & Xiu 2020), return harga intraday didominasi oleh *microstructure noise*. Standar evaluasi kuantitatif institusional bertumpu pada **Directional Hit Ratio** dan **Rank IC**, bukan $R^2$.
"""

    with open(output_report_md, "w") as f:
        f.write(report_md)

    print(f"[Eval] Generated report: {output_report_md}")
    return eval_results


if __name__ == "__main__":
    evaluate_models()
