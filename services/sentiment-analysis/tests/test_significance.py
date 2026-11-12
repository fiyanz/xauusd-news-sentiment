"""Tests for the F4 significance contract.

Verifies that ``reports/significance.json`` exists, that ``sentiment_adds_value``
is derived from the p-values (never hardcoded), and that the champion is the
argmax of the cross-validation summary.
"""

import json
import os
from pathlib import Path

import numpy as np
import pytest

from src.evaluate.significance import (
    SIGNIFICANCE_BASIS,
    binomtest_pvalue,
    negative_control_ic,
    pesaran_timmermann_test,
    select_champion_from_cv,
    sentiment_adds_value_from_pvalues,
    wilson_ci,
)

SIGNIFICANCE_PATH = "reports/significance.json"
REQUIRED_KEYS = [
    "champion_name",
    "selection_method",
    "test_samples",
    "hit_ratio_sig",
    "hit_ratio_ci95",
    "hit_ratio_pvalue",
    "rank_ic",
    "rank_ic_pvalue",
    "pesaran_timmermann_stat",
    "pesaran_timmermann_pvalue",
    "negative_control_ic",
    "sentiment_adds_value",
    "sentiment_adds_value_basis",
]


def _load():
    assert os.path.exists(SIGNIFICANCE_PATH), f"{SIGNIFICANCE_PATH} must exist"
    with open(SIGNIFICANCE_PATH, "r") as f:
        return json.load(f)


def test_significance_report_exists_and_contract_shape():
    sig = _load()
    for key in REQUIRED_KEYS:
        assert key in sig, f"Missing contract key: {key}"
    assert sig["selection_method"] in ("cv_mean_rank_ic", "cv_mean_hit_sig")
    assert isinstance(sig["test_samples"], int) and sig["test_samples"] > 0
    assert isinstance(sig["sentiment_adds_value"], bool)
    assert len(sig["hit_ratio_ci95"]) == 2


def test_sentiment_adds_value_is_honest():
    """sentiment_adds_value must reflect the fair comparison, not just p-values."""
    sig = _load()
    if "delta_rank_ic" in sig and "paired_ic_test" in sig:
        expected = sig["delta_rank_ic"] > 0 and sig["paired_ic_test"]["p_value"] < 0.05
        assert sig["sentiment_adds_value"] == expected, (
            "sentiment_adds_value must be the paired bootstrap delta vs baseline"
        )
    elif sig.get("sentiment_adds_value_note"):
        assert sig["sentiment_adds_value"] is False
    else:
        rank_p = sig["rank_ic_pvalue"]
        hit_p = sig["hit_ratio_pvalue"]
        expected = (rank_p is not None and rank_p < 0.05) or (hit_p is not None and hit_p < 0.05)
        assert sig["sentiment_adds_value"] == expected, (
            "sentiment_adds_value must be derived from the p-values, not hardcoded"
        )


def test_champion_matches_best_cv():
    sig = _load()
    cv = sig["cv_summary"]
    assert cv, "significance.json must embed cv_summary"
    metric = "hit_ratio_sig" if sig["selection_method"] == "cv_mean_hit_sig" else "rank_ic"
    best = max(cv, key=lambda name: cv[name][metric])
    assert sig["champion_name"] == best

    # Cross-check against the model bundle when it exposes a CV summary.
    bundle_path = "models/champion_fair_model.joblib"
    if os.path.exists(bundle_path):
        import joblib

        bundle = joblib.load(bundle_path)
        bundle_cv = bundle.get("cv_summary", {})
        if bundle_cv and metric in next(iter(bundle_cv.values())):
            bundle_best = max(bundle_cv, key=lambda name: bundle_cv[name][metric])
            assert sig["champion_name"] == bundle_best


def test_wilson_ci_known_values():
    low, high = wilson_ci(0, 10)
    assert low == 0.0
    assert 0.0 < high < 0.5

    low, high = wilson_ci(50, 100)
    assert low < 0.5 < high

    # The F4 finding: 87 hits in 158 significant buckets.
    low, high = wilson_ci(87, 158)
    assert low < 0.5506 < high

    assert wilson_ci(0, 0) == (None, None)


def test_binomtest_known_values():
    # A perfect coin is never surprising.
    assert binomtest_pvalue(50, 100) == pytest.approx(1.0)
    # Strong evidence against the coin.
    assert binomtest_pvalue(80, 100) < 1e-4
    # The F4 finding: 87/158 is not significant.
    assert binomtest_pvalue(87, 158) > 0.05
    assert binomtest_pvalue(0, 0) is None


def test_sentiment_adds_value_from_pvalues():
    assert sentiment_adds_value_from_pvalues(0.01, 0.5) is True
    assert sentiment_adds_value_from_pvalues(0.5, 0.01) is True
    assert sentiment_adds_value_from_pvalues(0.5, 0.5) is False
    assert sentiment_adds_value_from_pvalues(None, None) is False


def test_pesaran_timmermann_perfect_prediction():
    y = np.array([-2.0, -1.0, 1.0, 2.0, 3.0])
    stat, pval = pesaran_timmermann_test(y, y.copy())
    assert stat > 0
    assert pval < 0.05


def test_negative_control_near_zero():
    rng = np.random.default_rng(7)
    y = rng.normal(size=500)
    preds = rng.normal(size=500)
    ic = negative_control_ic(y, preds, seed=42)
    assert abs(ic) < 0.15


def test_select_champion_from_cv():
    cv = {
        "Random_Forest": {"rank_ic": 0.0912, "hit_ratio_sig": 54.79},
        "XGBoost": {"rank_ic": 0.0678, "hit_ratio_sig": 54.02},
        "LightGBM": {"rank_ic": 0.1034, "hit_ratio_sig": 55.11},
    }
    assert select_champion_from_cv(cv, "cv_mean_rank_ic") == "LightGBM"
    assert select_champion_from_cv(cv, "cv_mean_hit_sig") == "LightGBM"


def test_train_select_champion_is_argmax():
    from src.models.train import select_champion

    cv = {
        "A": {"rank_ic": 0.01, "hit_ratio_sig": 60.0},
        "B": {"rank_ic": 0.20, "hit_ratio_sig": 40.0},
    }
    assert select_champion(cv, "rank_ic") == "B"
    assert select_champion(cv, "hit_ratio_sig") == "A"
    with pytest.raises(ValueError):
        select_champion(cv, "bogus")


def test_predict_has_no_confidence_floor():
    source = Path("src/models/predict.py").read_text()
    assert "max(confidence, 51.0)" not in source, "confidence floor must be removed"
    assert "confidence_method" in source
    assert '"threshold"' in source


def test_evaluate_models_does_not_hardcode_sentiment_adds_value():
    source = Path("src/evaluate/evaluate_models.py").read_text()
    assert '"sentiment_adds_value": True' not in source
    assert "sentiment_adds_value_from_pvalues" in source


def test_legacy_artifact_is_labelled(tmp_path):
    """When the artifact is not provenance-verified the report must say so."""
    sig = _load()
    if sig.get("artifact_status") == "verified":
        pytest.skip("artifact is verified; legacy labelling not applicable")
    assert sig.get("is_simulated") is True
    assert "disclaimer" in sig
    assert "legacy" in sig["artifact_status"] or "stale" in sig["artifact_status"]
