"""Retrain + evaluation stage of the data pipeline.

A data refresh that never retrains leaves the model and every report stale
relative to the data. This module is the bridge: after the bucketed feature
artifact is rebuilt, it retrains the champion, rebuilds the significance and
fair-comparison reports, and regenerates the live prediction from the *new*
bundle.

Design rules:
- Never fabricate a result. If the artifact is missing or too small, the stage
  returns ``status: skipped`` and leaves the previous model/reports untouched.
- Never crash the pipeline. A failure here is reported, not raised.
"""

import os
import sys
from pathlib import Path

# Make ``src`` importable when run as a plain script from the repo root.
_repo_service_dir = Path(__file__).resolve().parents[2]
if str(_repo_service_dir) not in sys.path:
    sys.path.insert(0, str(_repo_service_dir))

from src.evaluate.evaluate_fair import evaluate_fair_test
from src.evaluate.evaluate_models import evaluate_models
from src.evaluate.significance import build_significance_report
from src.models.predict import generate_live_prediction
from src.models.train import train_models
from src.pipeline.provenance import merge_provenance, now_str, write_provenance

# Di bawah jumlah sampel ini, CV/evaluasi tidak bermakna dan champion selection
# hanya akan menghasilkan noise. 20 bucket 4H adalah ambang praktis minimum
# (5-fold walk-forward CV masih menghasilkan lipatan); hasil pada sampel kecil
# dilaporkan apa adanya oleh reports/significance.json (tidak signifikan).
MIN_SAMPLES = 20


def run_training_and_evaluation(
    features_parquet: str = "data/processed/bucketed_features.parquet",
    min_samples: int = MIN_SAMPLES,
    write_prediction: bool = True,
) -> dict:
    """Retrain the champion and rebuild every derived artifact.

    Returns a status dict:
      * ``status: "ok"``      -> model + reports + prediction refreshed
      * ``status: "skipped"`` -> insufficient/missing data; nothing overwritten
      * ``status: "failed"``  -> unexpected error; nothing fabricated
    """
    import pandas as pd

    if not os.path.exists(features_parquet):
        return {
            "status": "skipped",
            "reason": f"{features_parquet} tidak ada; pipeline data belum dijalankan.",
        }

    try:
        n_samples = len(pd.read_parquet(features_parquet))
    except Exception as exc:  # noqa: BLE001 - report, don't crash
        return {
            "status": "failed",
            "reason": f"artifact tidak bisa dibaca: {type(exc).__name__}: {exc}",
        }

    if n_samples < min_samples:
        return {
            "status": "skipped",
            "reason": (
                f"sampel terlalu sedikit ({n_samples} < {min_samples}) untuk "
                "training/CV yang bermakna; model lama dipertahankan."
            ),
            "samples": n_samples,
        }

    print("=" * 60)
    print(f"[PipelineRetrain] Retrain + evaluasi di atas artifact baru ({n_samples} sampel)...")
    if n_samples < 40:
        print(
            "[PipelineRetrain] PERINGATAN: sampel kecil — hasil CV/evaluasi sangat "
            "noise dan hampir pasti tidak signifikan; lihat reports/significance.json."
        )
    print("=" * 60)

    try:
        print("\n--- Train (champion by CV) ---")
        train_models(features_parquet=features_parquet)

        print("\n--- Significance ---")
        significance = build_significance_report(features_parquet=features_parquet)

        print("\n--- Eval Fair ---")
        evaluate_fair_test(features_parquet=features_parquet)

        print("\n--- Eval Models ---")
        evaluate_models(features_parquet=features_parquet)

        prediction = None
        if write_prediction:
            print("\n--- Predict ---")
            prediction = generate_live_prediction(features_parquet=features_parquet)

        # Provenance: model & significance ikut tercatat di manifest.
        now = now_str()
        manifest = merge_provenance(
            "data/processed/provenance.json",
            [
                {
                    "artifact": "models/champion_fair_model.joblib",
                    "source": "retrain pipeline (src.models.train, champion by CV)",
                    "generated_at": now,
                    "is_simulated": False,
                    "champion_name": significance.get("champion_name"),
                },
                {
                    "artifact": "reports/significance.json",
                    "source": "retrain pipeline (src.evaluate.significance)",
                    "generated_at": now,
                    "is_simulated": False,
                    "rank_ic": significance.get("rank_ic"),
                    "rank_ic_pvalue": significance.get("rank_ic_pvalue"),
                    "sentiment_adds_value": significance.get("sentiment_adds_value"),
                },
            ],
        )
        write_provenance("data/processed/provenance.json", manifest)

        return {
            "status": "ok",
            "samples": n_samples,
            "champion_name": significance.get("champion_name"),
            "selection_method": significance.get("selection_method"),
            "rank_ic": significance.get("rank_ic"),
            "rank_ic_pvalue": significance.get("rank_ic_pvalue"),
            "hit_ratio_sig": significance.get("hit_ratio_sig"),
            "sentiment_adds_value": significance.get("sentiment_adds_value"),
            "artifact_status": significance.get("artifact_status"),
            "prediction": prediction,
        }
    except Exception as exc:  # noqa: BLE001 - report, don't crash the pipeline
        return {
            "status": "failed",
            "reason": f"{type(exc).__name__}: {exc}",
            "samples": n_samples,
        }


if __name__ == "__main__":
    result = run_training_and_evaluation()
    print(f"\n[PipelineRetrain] status={result.get('status')} reason={result.get('reason', '-')}")
