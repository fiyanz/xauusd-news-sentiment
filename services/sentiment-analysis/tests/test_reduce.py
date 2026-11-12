"""Tests for feature preprocessing & dimensionality reduction."""

import joblib
import numpy as np
import pandas as pd

from src.features.reduce import FeatureReducer, add_cyclical_time, apply_bundle_features


def _frame(n: int = 12) -> pd.DataFrame:
    rng = np.random.default_rng(0)
    return pd.DataFrame(
        {
            "z_score": rng.normal(size=n),
            "surprise_val": rng.normal(size=n),
            "has_event": rng.integers(0, 2, size=n),
            "hour_utc": rng.integers(0, 24, size=n),
            "dayofweek": rng.integers(0, 7, size=n),
            "session_Asia": rng.integers(0, 2, size=n),
            "session_London": rng.integers(0, 2, size=n),
            "session_NewYork": rng.integers(0, 2, size=n),
            "sentiment_score": rng.normal(size=n),
            "sentiment_min": rng.normal(size=n),
            "sentiment_max": rng.normal(size=n),
            "overall_sentiment_score": rng.normal(size=n),
            "article_count": rng.integers(1, 5, size=n),
            **{f"macro_{i}": rng.normal(size=n) for i in range(3)},
            **{f"topic_{i}": rng.normal(size=n) for i in range(3)},
            **{f"sentiment_x_{i}": rng.normal(size=n) for i in range(2)},
            **{f"tfidf_{i}": rng.normal(size=n) for i in range(4)},
        }
    )


def test_cyclical_encoding():
    df = pd.DataFrame({"hour_utc": [0, 6, 12, 18], "dayofweek": [0, 1, 2, 3]})
    out = add_cyclical_time(df)
    assert np.isclose(out.loc[0, "hour_sin"], 0.0)
    assert np.isclose(out.loc[0, "hour_cos"], 1.0)
    assert np.isclose(out.loc[2, "hour_sin"], 0.0)
    assert np.isclose(out.loc[2, "hour_cos"], -1.0)


def test_reducer_compresses_blocks_and_keeps_base():
    df = _frame()
    r = FeatureReducer().fit(df)
    # Semua blok berkorelasi (termasuk TF-IDF yang dulu menganggur) terkompresi.
    for comp in ("macro_pc1", "topic_pc1", "interaction_pc1", "tfidf_pc1"):
        assert comp in r.feature_cols
    assert "sentiment_score" in r.feature_cols
    assert "hour_sin" in r.feature_cols
    # Fitur mentah berkorelasi diganti komponen, bukan dibuang.
    assert not [c for c in r.feature_cols if c.startswith("macro_") and not c.startswith("macro_pc")]
    block_raw = sum(len(b["cols"]) for b in r.blocks.values())
    block_comp = sum(len(b["comps"]) for b in r.blocks.values())
    assert block_comp < block_raw


def test_reducer_transform_shape_and_determinism():
    df = _frame()
    r = FeatureReducer().fit(df)
    out = r.transform(df)
    assert list(out.columns) == r.feature_cols
    assert len(out) == len(df)
    pd.testing.assert_frame_equal(out, r.transform(df))


def test_transform_uses_fitted_basis_not_refit():
    """Data di luar training tidak boleh mengubah basis PCA (anti look-ahead)."""
    df = _frame()
    r = FeatureReducer().fit(df.iloc[:8])
    before = r.transform(df.iloc[8:])
    _ = r.transform(df.iloc[:8])  # transformasi lain tidak boleh mengubah state
    after = r.transform(df.iloc[8:])
    pd.testing.assert_frame_equal(before, after)


def test_bundle_reducer_is_used():
    bundle = joblib.load("models/champion_fair_model.joblib")
    assert bundle.get("reducer") is not None
    df = pd.read_parquet("data/processed/bucketed_features.parquet")
    X = apply_bundle_features(bundle, df)
    assert X.shape[1] == len(bundle["champion_feature_cols"])
    # TF-IDF is only present when training had text; the reducer must honor that.
    if not any(c.startswith("tfidf_") for c in bundle["champion_feature_cols"]):
        assert not any(c.startswith("tfidf_") for c in X.columns)


def test_reducer_skips_constant_block():
    """A block that is constant in training cannot be compressed and is skipped."""
    df = _frame()
    for i in range(4):
        df[f"tfidf_{i}"] = 0.0
    r = FeatureReducer().fit(df)
    assert "tfidf_pc1" not in r.feature_cols
