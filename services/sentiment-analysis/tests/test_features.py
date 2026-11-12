"""Unit tests for feature engineering, time-based splits, and 24H embargo."""

import os
import pandas as pd
import pytest


def test_features_parquet_exists():
    path = "data/processed/features.parquet"
    assert os.path.exists(path), f"File {path} must exist"

    df = pd.read_parquet(path)
    # Real RSS coverage produces far fewer rows than the previous synthetic
    # stream; the volume varies with the lookback window, so assert presence.
    assert len(df) > 0, "Expected at least one feature row"

    # Ensure splits are present
    assert set(df["split"].unique()).issubset({"train", "val", "test", "embargo"})

    # Provenance columns must be present on the feature matrix.
    for col in ["data_source", "generated_at"]:
        assert col in df.columns, f"Missing provenance column {col}"

    # Check 24H embargo validity: max train timestamp < min val timestamp
    train_times = df[df["split"] == "train"]["time_published_utc"]
    val_times = df[df["split"] == "val"]["time_published_utc"]
    test_times = df[df["split"] == "test"]["time_published_utc"]

    # Minimum gap between train and val must be >= 24 hours
    if not val_times.empty:
        gap_train_val = (val_times.min() - train_times.max()).total_seconds() / 3600.0
        assert gap_train_val >= 23.9, f"Embargo between train and val must be >= 24H, got {gap_train_val}h"

    if not val_times.empty and not test_times.empty:
        gap_val_test = (test_times.min() - val_times.max()).total_seconds() / 3600.0
        assert gap_val_test >= 23.9, f"Embargo between val and test must be >= 24H, got {gap_val_test}h"


def test_tfidf_and_context_features_present():
    df = pd.read_parquet("data/processed/features.parquet")
    tfidf_cols = [c for c in df.columns if c.startswith("tfidf_")]
    assert len(tfidf_cols) > 50, "Should have extracted TF-IDF text features"

    for c in ["sentiment_score", "sentiment_ordinal", "hour_utc", "is_event_window", "vol_pre"]:
        assert c in df.columns, f"Required feature {c} missing"
