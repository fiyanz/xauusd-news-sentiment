"""Out-of-Time Test Set evaluation for Fair Baseline vs Full Sentiment Model."""

import json
import os
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
import yaml

from src.evaluate.significance import (
    SIGNIFICANCE_BASIS,
    binomtest_pvalue,
    load_significance_report,
    pesaran_timmermann_test,  # re-exported for backwards compatibility
    sentiment_adds_value_from_pvalues,
    wilson_ci,
)


def load_config() -> dict:
    for path in [Path("config.yaml"), Path("services/sentiment-analysis/config.yaml")]:
        if path.exists():
            with open(path, "r") as f:
                return yaml.safe_load(f)
    return {}


def evaluate_fair_test(
    features_parquet: str = "data/processed/bucketed_features.parquet",
    model_bundle_path: str = "models/champion_fair_model.joblib",
    output_report_md: str = "reports/reformed_evaluation.md",
    output_json_path: str = "reports/fair_comparison_results.json",
    seed: int = 42,
) -> dict:
    """Evaluate Fair Baseline vs Full Model on untouched out-of-time Test partition."""
    os.makedirs(os.path.dirname(output_report_md), exist_ok=True)
    print(f"[EvalFair] Loading test data from {features_parquet}...")
    df = pd.read_parquet(features_parquet)

    test_df = df[df["split"] == "test"].reset_index(drop=True)
    print(f"[EvalFair] Untouched test set samples: {len(test_df)}")

    bundle = joblib.load(model_bundle_path)
    target_col = bundle["target_col"]

    y_test = test_df[target_col].values
    vol_test = test_df["vol_pre"].values

    eval_results = {"test_samples": len(test_df), "target": target_col, "models": {}}

    models_to_test = [
        ("baseline", bundle["baseline_name"], bundle["baseline_model"], bundle["baseline_feature_cols"]),
        ("full", bundle["champion_name"], bundle["champion_model"], bundle["champion_feature_cols"]),
    ]

    for model_key, name, model, cols in models_to_test:

        X_test = test_df[cols].fillna(0.0).values
        preds = model.predict(X_test)

        # 1. Spearman Rank IC
        ic, pval = spearmanr(preds, y_test)
        if np.isnan(ic):
            ic, pval = 0.0, 1.0

        # 2. Top 20% vs Bottom 20% Quintile return spread
        q80 = float(np.percentile(preds, 80))
        q20 = float(np.percentile(preds, 20))
        top_mask = preds >= q80
        bot_mask = preds <= q20
        quintile_spread = (
            float(np.mean(y_test[top_mask]) - np.mean(y_test[bot_mask]))
            if (top_mask.sum() > 0 and bot_mask.sum() > 0)
            else 0.0
        )

        # 3. Directional Hit Ratio on significant moves (|R| > 0.5 * vol)
        sig_mask = np.abs(y_test) > (0.5 * vol_test)
        if sig_mask.sum() > 0:
            hits = int(np.sum(np.sign(preds[sig_mask]) == np.sign(y_test[sig_mask])))
            n_sig = int(sig_mask.sum())
            hit_ratio = hits / n_sig
            hit_ci = wilson_ci(hits, n_sig)
            hit_pvalue = binomtest_pvalue(hits, n_sig)
        else:
            hits = 0
            n_sig = 0
            hit_ratio = None
            hit_ci = (None, None)
            hit_pvalue = None

        # 4. Pesaran-Timmermann Test
        pt_stat, pt_pval = pesaran_timmermann_test(y_test, preds)

        # 5. Shuffled negative control
        rng = np.random.default_rng(seed)
        shuffled_ic, _ = spearmanr(preds, rng.permutation(y_test))

        eval_results["models"][model_key] = {
            "name": name,
            "feature_count": len(cols),
            "spearman_rank_ic": round(float(ic), 4),
            "ic_pvalue": round(float(pval), 5),
            "quintile_spread": round(float(quintile_spread), 6),
            "directional_hit_ratio": None if hit_ratio is None else round(float(hit_ratio), 4),
            "directional_hit_ratio_hits": hits,
            "directional_hit_ratio_n": n_sig,
            "hit_ratio_ci95": [
                None if hit_ci[0] is None else round(float(hit_ci[0]), 4),
                None if hit_ci[1] is None else round(float(hit_ci[1]), 4),
            ],
            "hit_ratio_pvalue": None if hit_pvalue is None else round(float(hit_pvalue), 5),
            "pesaran_timmermann_stat": round(float(pt_stat), 4),
            "pt_pvalue": round(float(pt_pval), 5),
            "negative_control_ic": round(float(shuffled_ic), 4),
        }

    # Compare Alpha Delta (Full - Baseline). sentiment_adds_value is derived
    # from the full model's own significance, never from the sign of the delta.
    base_res = eval_results["models"]["baseline"]
    full_res = eval_results["models"]["full"]
    ic_delta = round(full_res["spearman_rank_ic"] - base_res["spearman_rank_ic"], 4)

    base_hit = base_res["directional_hit_ratio"] or 0.0
    full_hit = full_res["directional_hit_ratio"] or 0.0
    hit_delta = round(full_hit - base_hit, 4)

    sentiment_adds_value = sentiment_adds_value_from_pvalues(
        full_res["ic_pvalue"], full_res["hit_ratio_pvalue"]
    )

    eval_results["delta_alpha"] = {
        "rank_ic_improvement": ic_delta,
        "hit_ratio_improvement": hit_delta,
        "sentiment_adds_value": bool(sentiment_adds_value),
        "sentiment_adds_value_basis": SIGNIFICANCE_BASIS,
        "rank_ic_pvalue": full_res["ic_pvalue"],
        "hit_ratio_pvalue": full_res["hit_ratio_pvalue"],
        "hit_ratio_ci95": full_res["hit_ratio_ci95"],
    }

    # Save JSON metrics
    with open(output_json_path, "w") as f:
        json.dump(eval_results, f, indent=2)

    # Markdown Report
    b_res = eval_results["models"]["baseline"]
    f_res = eval_results["models"]["full"]

    sig_report = load_significance_report()
    artifact_banner = ""
    if sig_report and sig_report.get("artifact_status") not in (None, "verified"):
        artifact_banner = (
            "> **STATUS: Artifact legacy (data sintetis).** "
            f"(`artifact_status={sig_report.get('artifact_status')}`) "
            "Retrain ditunda ke tahap integrasi (F1). Angka di bawah adalah diagnostik legacy, "
            "bukan hasil akhir.\n\n"
        )

    conclusion = (
        "Sentimen **secara statistik menambah nilai** (p < 0.05)."
        if sentiment_adds_value
        else "TIDAK ada bukti statistik bahwa sentimen menambah nilai (p >= 0.05). "
        "Delta positif pada titik ini masih mungkin berasal dari kebetulan."
    )

    def _pct(v):
        return "N/A" if v is None else f"{v * 100:.2f}%"

    def _p(v):
        return "N/A" if v is None else f"{v:.5f}"

    def _ci(ci):
        return "N/A" if ci[0] is None else f"[{ci[0]:.4f}, {ci[1]:.4f}]"

    report_md = f"""# Laporan Evaluasi Terpadu: Fair Baseline vs Full Sentiment Model (XAUUSD)

{artifact_banner}## 1. Ringkasan Eksekutif & Metodologi
- **Target Utama**: Return kontinu 4H ($R_{{4\\text{{H}}}}$).
- **Unit Analisis**: Bucket 4-Jam & Jendela Rilis Event Berdampak Tinggi ($N = {len(test_df)}$ baris pada Set Uji Out-of-Time).
- **Desain Pengujian Adil (Fair Comparison)**:
  - **Fair Baseline**: Model hanya menggunakan angka rilis kalender ekonomi (*standardized surprise* $Z$-Score) dan fitur kalender waktu.
  - **Full Model**: Baseline + Fitur Sentimen Berita + *Topic Interaction Terms* (`sentiment × topic`).

## 2. Hasil Komparasi Out-of-Time Test Set
| Metrik Kuantitatif | Fair Baseline ({b_res['name']}) | Full Model ({f_res['name']}) | Delta (Full - Base) | Interpretasi |
| :--- | :---: | :---: | :---: | :--- |
| **Jumlah Fitur** | {b_res['feature_count']} | {f_res['feature_count']} | +{f_res['feature_count'] - b_res['feature_count']} | Dimensi fitur diperluas dengan interaksi teks |
| **Spearman Rank IC** | **{b_res['spearman_rank_ic']:+.4f}** | **{f_res['spearman_rank_ic']:+.4f}** | **{ic_delta:+.4f}** | {'Penambahan sentimen meningkatkan korelasi peringkat' if ic_delta > 0 else 'Baseline makro lebih unggul secara IC'} |
| **IC p-value** | {b_res['ic_pvalue']:.5f} | {f_res['ic_pvalue']:.5f} | — | Nilai signifikansi statistik korelasi |
| **Quintile Return Spread ($Q_5 - Q_1$)** | {b_res['quintile_spread']:+.6f} | {f_res['quintile_spread']:+.6f} | {f_res['quintile_spread'] - b_res['quintile_spread']:+.6f} | Selisih return kuantil teratas vs terbawah |
| **Directional Hit Ratio (|R| > 0.5σ)** | {_pct(b_res['directional_hit_ratio'])} | {_pct(f_res['directional_hit_ratio'])} | {hit_delta * 100:+.2f}% | Akurasi arah pada pergerakan signifikan |
| **Hit Ratio p-value (binomial)** | {_p(b_res['hit_ratio_pvalue'])} | {_p(f_res['hit_ratio_pvalue'])} | — | Uji dua-arah terhadap 50% |
| **Hit Ratio CI95 (Wilson)** | {_ci(b_res['hit_ratio_ci95'])} | {_ci(f_res['hit_ratio_ci95'])} | — | Interval kepercayaan 95% |
| **Pesaran-Timmermann Test (Stat / p)** | {b_res['pesaran_timmermann_stat']:.2f} (p={b_res['pt_pvalue']:.3f}) | {f_res['pesaran_timmermann_stat']:.2f} (p={f_res['pt_pvalue']:.3f}) | — | Uji non-parametrik independensi arah pasar |
| **Kontrol Negatif (Shuffled Labels IC)** | {b_res['negative_control_ic']:+.4f} | {f_res['negative_control_ic']:+.4f} | — | Mendekati 0, membuktikan ketiadaan kebocoran temporal |

## 3. Temuan Ilmiah & Kesimpulan Kuantitatif
1. **Bukti Nilai Tambah Sentimen Teks**:
   - Model Lengkap dengan fitur interaksi topik menghasilkan Rank IC sebesar **{f_res['spearman_rank_ic']:+.4f}** (p = {_p(f_res['ic_pvalue'])}) dan Directional Hit Ratio **{_pct(f_res['directional_hit_ratio'])}** (p = {_p(f_res['hit_ratio_pvalue'])}, CI95 {_ci(f_res['hit_ratio_ci95'])}) pada data uji *out-of-time*.
   - {conclusion}
   - `sentiment_adds_value = {str(bool(sentiment_adds_value)).lower()}` (basis: `{SIGNIFICANCE_BASIS}`).
2. **Kepatuhan Kuantitatif (FR-10)**:
   - Evaluasi ini adalah studi empiris daya prediksi informasi, bukan rekomendasi sinyal transaksi beli/jual.
   - Sinyal dievaluasi dengan uji kontrol negatif dan uji non-parametrik Pesaran-Timmermann; klaim signifikansi hanya diajukan bila p < 0.05.
"""

    with open(output_report_md, "w") as f:
        f.write(report_md)

    print(f"\n[EvalFair] Fair benchmark evaluation completed!")
    print(f"           Baseline IC: {b_res['spearman_rank_ic']:+.4f} | Full Model IC: {f_res['spearman_rank_ic']:+.4f} (Delta: {ic_delta:+.4f})")
    print(f"           Baseline Hit: {b_res['directional_hit_ratio'] * 100:.2f}% | Full Model Hit: {f_res['directional_hit_ratio'] * 100:.2f}% (Delta: {hit_delta * 100:+.2f}%)")
    print(f"           sentiment_adds_value={bool(sentiment_adds_value)} (basis: {SIGNIFICANCE_BASIS})")
    print(f"           Report saved: {output_report_md}")

    return eval_results


if __name__ == "__main__":
    evaluate_fair_test()
