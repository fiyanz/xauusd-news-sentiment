"""Both evaluation reports must describe the SAME fair baseline.

Regression test for the ``-0.0021 vs +0.0021`` contradiction: ``evaluate_models``
used to score ``trained_models['LightGBM']`` on the 28 champion features and
label it "baseline", while ``significance.json`` used the bundle's macro-only
``baseline_model``.  The delta sign flipped depending on which module ran last.

The canonical definition lives in ``src.evaluate.significance`` and both
reports must embed it.
"""

import json
import os

import joblib

from src.evaluate.significance import baseline_descriptor

SIG_PATH = "reports/significance.json"
FAIR_PATH = "reports/fair_comparison_results.json"
FULL_PATH = "reports/full_metrics_evaluation.json"
BUNDLE_PATH = "models/champion_fair_model.joblib"
REPORT_PATHS = (SIG_PATH, FAIR_PATH, FULL_PATH)
MD_PATHS = ("reports/reformed_evaluation.md", "reports/full_metrics_evaluation.md")


def _load(path):
    assert os.path.exists(path), f"{path} must exist"
    with open(path, "r") as f:
        return json.load(f)


def test_reports_embed_the_bundle_baseline_descriptor():
    bundle = joblib.load(BUNDLE_PATH)
    expected = baseline_descriptor(bundle, BUNDLE_PATH)

    for path in REPORT_PATHS:
        report = _load(path)
        assert "baseline" in report, f"{path} must embed the baseline descriptor"
        assert report["baseline"] == expected, (
            f"{path} baseline descriptor does not match the bundle baseline"
        )


def test_baseline_is_not_a_champion_feature_model():
    """The baseline must be the bundle's reduced model, not a full-feature model."""
    bundle = joblib.load(BUNDLE_PATH)
    baseline_cols = set(bundle["baseline_feature_cols"])
    champion_cols = set(bundle["champion_feature_cols"])

    assert baseline_cols, "baseline_feature_cols must not be empty"
    assert baseline_cols < champion_cols, (
        "baseline features must be a strict subset of the champion features"
    )
    # No text/topic blocks: that is what makes it the *fair* baseline.
    assert not any(c.startswith(("topic_", "tfidf_")) for c in baseline_cols)


def test_delta_rank_ic_is_identical_across_reports():
    sig = _load(SIG_PATH)
    fair = _load(FAIR_PATH)

    assert sig["baseline_rank_ic"] == fair["models"]["baseline"]["spearman_rank_ic"]
    assert sig["delta_rank_ic"] == fair["delta_alpha"]["rank_ic_improvement"]
    assert sig["sentiment_adds_value"] == fair["delta_alpha"]["sentiment_adds_value"]
    assert sig["champion_name"] == fair["models"]["full"]["name"]
    assert sig["test_samples"] == fair["test_samples"]


def test_delta_is_full_minus_baseline():
    sig = _load(SIG_PATH)
    fair = _load(FAIR_PATH)

    expected = round(
        fair["models"]["full"]["spearman_rank_ic"]
        - fair["models"]["baseline"]["spearman_rank_ic"],
        4,
    )
    assert fair["delta_alpha"]["rank_ic_improvement"] == expected
    assert sig["delta_rank_ic"] == expected


def test_sentiment_adds_value_is_derived_from_the_shared_baseline():
    sig = _load(SIG_PATH)
    paired = sig["paired_ic_test"]
    assert paired is not None, "paired bootstrap vs baseline must be reported"
    expected = sig["delta_rank_ic"] > 0 and paired["p_value"] < 0.05
    assert sig["sentiment_adds_value"] == expected


def test_full_metrics_report_reuses_the_significance_basis():
    """full_metrics_evaluation.json must not claim a different basis than significance."""
    sig = _load(SIG_PATH)
    full = _load(FULL_PATH)
    significance = full["significance"]

    assert significance["sentiment_adds_value"] == sig["sentiment_adds_value"]
    assert significance["sentiment_adds_value_basis"] == sig["sentiment_adds_value_basis"]
    assert significance["rank_ic_pvalue"] == sig["rank_ic_pvalue"]


def test_markdown_reports_state_the_same_basis_and_artifact_status():
    """Markdown reports must cite the shared basis and the true artifact status.

    A markdown that says "p-value basis" while the JSON says "paired vs
    baseline" (or that calls a ``stale`` real-data artifact "synthetic") is the
    same class of misreporting as the original delta-sign contradiction.
    """
    sig = _load(SIG_PATH)
    basis = sig["sentiment_adds_value_basis"]
    status = sig.get("artifact_status")

    for path in MD_PATHS:
        assert os.path.exists(path), f"{path} must exist"
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        assert f"`{basis}`" in text, f"{path} must cite the shared sentiment_adds_value basis"
        if status in (None, "verified"):
            continue
        assert f"artifact_status={status}" in text, (
            f"{path} must state artifact_status={status}"
        )
        if status != "legacy_synthetic":
            assert "data sintetis" not in text, (
                f"{path} must not call a {status} artifact synthetic data"
            )
