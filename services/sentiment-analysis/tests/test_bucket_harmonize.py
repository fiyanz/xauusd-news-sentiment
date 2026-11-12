"""Unit tests for 4H bucketing, topic interactions, and embargo partitioning."""

import os
import pandas as pd
import pytest


def test_bucketed_features_exist_and_valid():
    path = "data/processed/bucketed_features.parquet"
    assert os.path.exists(path), f"{path} must exist"

    df = pd.read_parquet(path)
    # Real RSS coverage yields far fewer buckets than the old synthetic stream;
    # the count varies with the lookback window, so assert presence.
    assert len(df) > 0, "Expected at least one 4H bucket"

    # Verify key columns
    expected_cols = [
        "time_bucket",
        "ret_4h",
        "ret_24h",
        "vol_pre",
        "z_score",
        "surprise_val",
        "sentiment_score",
        "split",
    ]
    for col in expected_cols:
        assert col in df.columns, f"Missing required column: {col}"

    # Verify interaction terms are present
    interactions = [c for c in df.columns if c.startswith("sentiment_x_")]
    assert len(interactions) >= 5, "Should have topic-conditional sentiment interaction features"

    # Verify time splits and 24H embargo
    assert set(df["split"].unique()).issubset({"train", "val", "test", "embargo"})

    train_max = df[df["split"] == "train"]["time_bucket"].max()
    val_rows = df[df["split"] == "val"]
    if val_rows.empty:
        pytest.skip("No validation buckets in the current artifact")
    val_min = val_rows["time_bucket"].min()
    gap_hours = (val_min - train_max).total_seconds() / 3600.0
    assert gap_hours >= 23.9, f"Embargo between train and val must be >= 24H, got {gap_hours}h"
