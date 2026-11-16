"""Out-of-Time Test Set evaluation for Fair Baseline vs Full Sentiment Model.

The baseline used here is the *bundle's* fair baseline (``baseline_model`` on
``baseline_feature_cols``), never "whichever trained model is not the
champion".  ``build_fair_comparison`` is the single builder for that
comparison and is also consumed by ``evaluate_models`` so
``reports/fair_comparison_results.json`` cannot be regenerated with a
different baseline definition.
"""

import json
import os
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
import yaml

from src.evaluate.significance import (
    PAIRED_BASIS,
    SIGNIFICANCE_BASIS,
    baseline_descriptor,
    binomtest_pvalue,
    compare_to_baseline,
    load_significance_report,
    pesaran_timmermann_test,
    predict_baseline,
    sentiment_adds_value_from_pvalues,
    sentiment_features_present,
    wilson_ci,
)
from src.features.reduce import apply_bundle_features

DEFAULT_MODEL_BUNDLE_PATH = "models/champion_fair_model.joblib"


def load_config() -> dict:
    for path in [Path("config.yaml"), Path("services/sentiment-analysis/config.yaml")]:
        if path.exists():
            with open(path, "r") as f:
                return yaml.safe_load(f)
    return {}


def _model_metrics(
    y_test: np.ndarray,
    preds: np.ndarray,
    vol_test: np.ndarray,
    name: "str | None",
    feature_count: int,
    seed: int,
) -> dict:
    """Rank IC, quintile spread, directional hit ratio and controls for one model."""
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

    return {
        "name": name,
        "feature_count": feature_count,
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


def build_fair_comparison(
    bundle: dict,
    test_df: pd.DataFrame,
    y_test: np.ndarray,
    vol_test: np.ndarray,
    seed: int = 42,
    model_bundle_path: str = DEFAULT_MODEL_BUNDLE_PATH,
    champion_name: str | None = None,
    champion_model=None,
) -> dict:
    """Build the fair baseline vs full model comparison.  No file I/O.

    Shared by ``evaluate_fair_test`` (markdown + JSON) and ``evaluate_models``
    (JSON compatibility copy) so both writers emit the same baseline and the
    same delta.
    """
    champion_name = champion_name or bundle["champion_name"]
    champion_model = champion_model if champion_model is not None else bundle["champion_model"]
    champion_cols = list(bundle["champion_feature_cols"])

    X_all = apply_bundle_features(bundle, test_df)
    baseline_pred = predict_baseline(bundle, test_df)
    full_pred = np.asarray(
        champion_model.predict(X_all[champion_cols].to_numpy(dtype=float)), dtype=float
    )

    eval_results = {
        "test_samples": len(test_df),
        "target": bundle["target_col"],
        "champion_name": champion_name,
        "selection_method": bundle.get("selection_method"),
        "baseline": baseline_descriptor(bundle, model_bundle_path),
        "models": {},
    }

    if baseline_pred is not None:
        eval_results["models"]["baseline"] = _model_metrics(
            y_test,
            baseline_pred,
            vol_test,
            bundle.get("baseline_name"),
            len(bundle.get("baseline_feature_cols") or []),
            seed,
        )
    else:
        eval_results["models"]["baseline"] = {
            "name": bundle.get("baseline_name"),
            "error": "baseline bundle tidak tersedia (baseline_model/baseline_feature_cols kosong)",
        }

    eval_results["models"]["full"] = _model_metrics(
        y_test, full_pred, vol_test, champion_name, len(champion_cols), seed
    )

    base_res = eval_results["models"]["baseline"]
    full_res = eval_results["models"]["full"]

    # Delta (Full - Baseline) and the honest sentiment_adds_value, both from
    # the canonical comparison in significance.py.
    has_sentiment = sentiment_features_present(champion_cols)
    comparison = (
        compare_to_baseline(y_test, full_pred, baseline_pred, seed=seed)
        if baseline_pred is not None
        else {}
    )

    if "delta_rank_ic" in comparison:
        ic_delta = comparison["delta_rank_ic"]
        paired = comparison["paired_ic_test"]
        sentiment_adds_value = bool(
            has_sentiment and comparison["sentiment_adds_value"]
        )
        basis = PAIRED_BASIS
    else:
        ic_delta = None
        paired = None
        sentiment_adds_value = (
            False
            if not has_sentiment
            else sentiment_adds_value_from_pvalues(
                full_res["ic_pvalue"], full_res["hit_ratio_pvalue"]
            )
        )
        basis = SIGNIFICANCE_BASIS

    base_hit = base_res.get("directional_hit_ratio") or 0.0
    full_hit = full_res.get("directional_hit_ratio") or 0.0

    eval_results["delta_alpha"] = {
        "rank_ic_improvement": ic_delta,
        "hit_ratio_improvement": round(full_hit - base_hit, 4),
        "sentiment_adds_value": bool(sentiment_adds_value),
        "sentiment_adds_value_basis": basis,
        "sentiment_adds_value_note": (
            None
            if has_sentiment
            else "fitur sentimen/topik/teks tidak ada di model (blok nol-varians di training)"
        ),
        "paired_ic_test": paired,
        "rank_ic_pvalue": full_res.get("ic_pvalue"),
        "hit_ratio_pvalue": full_res.get("hit_ratio_pvalue"),
        "hit_ratio_ci95": full_res.get("hit_ratio_ci95"),
    }
    return eval_results


def evaluate_fair_test(
    features_parquet: str = "data/processed/bucketed_features.parquet",
    model_bundle_path: str = DEFAULT_MODEL_BUNDLE_PATH,
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

    eval_results = build_fair_comparison(
        bundle,
        test_df,
        y_test,
        vol_test,
        seed=seed,
        model_bundle_path=model_bundle_path,
    )

    # Save JSON metrics
    with open(output_json_path, "w") as f:
        json.dump(eval_results, f, indent=2)

    # Markdown Report
    b_res = eval_results["models"]["baseline"]
    f_res = eval_results["models"]["full"]
    ic_delta = eval_results["delta_alpha"]["rank_ic_improvement"]
    hit_delta = eval_results["delta_alpha"]["hit_ratio_improvement"]
    sentiment_adds_value = eval_results["delta_alpha"]["sentiment_adds_value"]

    sig_report = load_significance_report()
    artifact_banner = ""
    if sig_report and sig_report.get("artifact_status") not in (None, "verified"):
        # Banner harus sesuai jenis artifact: "stale" = data nyata berumur
        # >24 jam, bukan data sintetis.  Ambil kalimat dari significance.json
        # (satu sumber kebenaran) supaya label tidak pernah bertabrakan.
        _status = sig_report.get("artifact_status")
        _detail = sig_report.get("disclaimer") or "Angka di bawah DIAGNOSTIK, bukan hasil akhir."
        artifact_banner = f"> **STATUS: artifact_status={_status}.** {_detail}\n\n"

    if "error" in b_res:
        # Baseline tidak tersedia di bundle: laporkan celah, jangan crash dan
        # jangan menerbitkan angka baseline karangan.
        report_md = (
            "# Laporan Evaluasi Terpadu: Fair Baseline vs Full Sentiment Model (XAUUSD)\n\n"
            f"{artifact_banner}## Status\n\n"
            f"Baseline bundle tidak tersedia: `{b_res['error']}`. "
            "Delta vs baseline dan `sentiment_adds_value` tidak dihitung "
            "(`null`/fallback p-value model penuh).\n"
        )
        with open(output_report_md, "w") as f:
            f.write(report_md)
        print(f"\n[EvalFair] Baseline tidak tersedia: {b_res['error']}")
        print(f"           Report saved: {output_report_md}")
        return eval_results

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

    baseline_desc = eval_results["baseline"]
    report_md = f"""# Laporan Evaluasi Terpadu: Fair Baseline vs Full Sentiment Model (XAUUSD)

{artifact_banner}## 1. Ringkasan Eksekutif & Metodologi
- **Target Utama**: Return kontinu 4H ($R_{{4\\text{{H}}}}$).
- **Unit Analisis**: Bucket 4-Jam & Jendela Rilis Event Berdampak Tinggi ($N = {len(test_df)}$ baris pada Set Uji Out-of-Time).
- **Desain Pengujian Adil (Fair Comparison)**:
  - **Fair Baseline**: `{baseline_desc['baseline_name']}` ({baseline_desc['baseline_model_type']}) pada {baseline_desc['baseline_feature_count']} fitur makro/event — `{baseline_desc['baseline_model_source']}` → `baseline_model` + `baseline_feature_cols`.
  - **Full Model**: `{f_res['name']}` pada {f_res['feature_count']} fitur (Baseline + Fitur Sentimen Berita + *Topic Interaction Terms*).

## 2. Hasil Komparasi Out-of-Time Test Set
| Metrik Kuantitatif | Fair Baseline ({b_res['name']}) | Full Model ({f_res['name']}) | Delta (Full - Base) | Interpretasi |
| :--- | :---: | :---: | :---: | :--- |
|| **Jumlah Fitur** | {b_res['feature_count']} | {f_res['feature_count']} | +{f_res['feature_count'] - b_res['feature_count']} | Dimensi fitur diperluas dengan interaksi teks |
|| **Spearman Rank IC** | **{b_res['spearman_rank_ic']:+.4f}** | **{f_res['spearman_rank_ic']:+.4f}** | **{ic_delta:+.4f}** | {'Penambahan sentimen meningkatkan korelasi peringkat' if ic_delta > 0 else 'Baseline makro lebih unggul secara IC'} |
|| **IC p-value** | {b_res['ic_pvalue']:.5f} | {f_res['ic_pvalue']:.5f} | — | Nilai signifikansi statistik korelasi |
|| **Quintile Return Spread ($Q_5 - Q_1$)** | {b_res['quintile_spread']:+.6f} | {f_res['quintile_spread']:+.6f} | {f_res['quintile_spread'] - b_res['quintile_spread']:+.6f} | Selisih return kuantil teratas vs terbawah |
|| **Directional Hit Ratio (|R| > 0.5σ)** | {_pct(b_res['directional_hit_ratio'])} | {_pct(f_res['directional_hit_ratio'])} | {hit_delta * 100:+.2f}% | Akurasi arah pada pergerakan signifikan |
|| **Hit Ratio p-value (binomial)** | {_p(b_res['hit_ratio_pvalue'])} | {_p(f_res['hit_ratio_pvalue'])} | — | Uji dua-arah terhadap 50% |
|| **Hit Ratio CI95 (Wilson)** | {_ci(b_res['hit_ratio_ci95'])} | {_ci(f_res['hit_ratio_ci95'])} | — | Interval kepercayaan 95% |
|| **Pesaran-Timmermann Test (Stat / p)** | {b_res['pesaran_timmermann_stat']:.2f} (p={b_res['pt_pvalue']:.3f}) | {f_res['pesaran_timmermann_stat']:.2f} (p={f_res['pt_pvalue']:.3f}) | — | Uji non-parametrik independensi arah pasar |
|| **Kontrol Negatif (Shuffled Labels IC)** | {b_res['negative_control_ic']:+.4f} | {f_res['negative_control_ic']:+.4f} | — | Mendekati 0, membuktikan ketiadaan kebocoran temporal |

## 3. Temuan Ilmiah & Kesimpulan Kuantitatif
1. **Bukti Nilai Tambah Sentimen Teks**:
   - Model Lengkap dengan fitur interaksi topik menghasilkan Rank IC sebesar **{f_res['spearman_rank_ic']:+.4f}** (p = {_p(f_res['ic_pvalue'])}) dan Directional Hit Ratio **{_pct(f_res['directional_hit_ratio'])}** (p = {_p(f_res['hit_ratio_pvalue'])}, CI95 {_ci(f_res['hit_ratio_ci95'])}) pada data uji *out-of-time*.
   - {conclusion}
   - `sentiment_adds_value = {str(bool(sentiment_adds_value)).lower()}` (basis: `{eval_results['delta_alpha']['sentiment_adds_value_basis']}`).
2. **Kepatuhan Kuantitatif (FR-10)**:
   - Evaluasi ini adalah studi empiris daya prediksi informasi, bukan rekomendasi sinyal transaksi beli/jual.
   - Sinyal dievaluasi dengan uji kontrol negatif dan uji non-parametrik Pesaran-Timmermann; klaim signifikansi hanya diajukan bila p < 0.05.
"""

    with open(output_report_md, "w") as f:
        f.write(report_md)

    print(f"\n[EvalFair] Fair benchmark evaluation completed!")
    print(
        f"           Baseline IC: {b_res['spearman_rank_ic']:+.4f} | "
        f"Full Model IC: {f_res['spearman_rank_ic']:+.4f} (Delta: {ic_delta:+.4f})"
    )
    print(
        f"           Baseline Hit: {_pct(b_res['directional_hit_ratio'])} | "
        f"Full Model Hit: {_pct(f_res['directional_hit_ratio'])} (Delta: {hit_delta * 100:+.2f}%)"
    )
    print(
        f"           sentiment_adds_value={bool(sentiment_adds_value)} "
        f"(basis: {eval_results['delta_alpha']['sentiment_adds_value_basis']})"
    )
    print(f"           Report saved: {output_report_md}")

    return eval_results


if __name__ == "__main__":
    evaluate_fair_test()
