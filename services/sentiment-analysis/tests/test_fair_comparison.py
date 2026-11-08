"""Unit tests for fair baseline benchmarking and evaluation metrics."""

import json
import os
import joblib
import pytest


def test_champion_fair_model_exists():
    path = "models/champion_fair_model.joblib"
    assert os.path.exists(path), f"{path} must exist"

    bundle = joblib.load(path)
    assert "baseline_model" in bundle
    assert "champion_model" in bundle
    assert "baseline_feature_cols" in bundle
    assert "champion_feature_cols" in bundle


def test_fair_comparison_results_report():
    json_path = "reports/fair_comparison_results.json"
    md_path = "reports/reformed_evaluation.md"

    assert os.path.exists(json_path), f"{json_path} must exist"
    assert os.path.exists(md_path), f"{md_path} must exist"

    with open(json_path, "r") as f:
        data = json.load(f)

    assert "models" in data
    assert "delta_alpha" in data
    assert "baseline" in data["models"]
    assert "full" in data["models"]

    # Verify that delta metrics are computed and recorded
    assert "rank_ic_improvement" in data["delta_alpha"]
    assert "hit_ratio_improvement" in data["delta_alpha"]
    assert "sentiment_adds_value" in data["delta_alpha"]
