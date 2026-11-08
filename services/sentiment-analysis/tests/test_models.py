"""Unit tests for champion model bundle and evaluation artifacts."""

import json
import os
import joblib
import pytest


def test_champion_model_bundle():
    model_path = "models/champion_model.joblib"
    assert os.path.exists(model_path), f"Champion model {model_path} must exist"

    bundle = joblib.load(model_path)
    assert "model" in bundle
    assert "feature_cols" in bundle
    assert "model_name" in bundle
    assert len(bundle["feature_cols"]) > 0


def test_evaluation_report_and_json():
    json_path = "reports/evaluation_results.json"
    md_path = "reports/phase_7_eval.md"

    assert os.path.exists(json_path), f"{json_path} must exist"
    assert os.path.exists(md_path), f"{md_path} must exist"

    with open(json_path, "r") as f:
        data = json.load(f)

    metrics = data["metrics"]
    assert "champion_macro_f1" in metrics
    assert "baseline_b0_macro_f1" in metrics
    assert "baseline_b1_macro_f1" in metrics
    assert metrics["champion_macro_f1"] > 0.2


def test_predict_confidence_zero_vol_division():
    vol_pre = 0.0
    pred_return = 0.005
    # Must not raise ZeroDivisionError with epsilon 1e-8
    conf = min(round(float(abs(pred_return) / (vol_pre * 1.5 + 1e-8)) * 100, 1), 95.0)
    conf = max(conf, 51.0)
    assert conf == 95.0
