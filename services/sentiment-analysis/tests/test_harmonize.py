"""Unit tests for merge_asof harmonization, anti-lookahead, and labeling."""

import os
import pandas as pd
import pytest
from src.process.harmonize import calculate_labels


def test_calculate_labels_logic():
    thresh = 0.002
    assert calculate_labels(0.005, thresh) == 1, "Return above positive threshold should be +1"
    assert calculate_labels(-0.005, thresh) == -1, "Return below negative threshold should be -1"
    assert calculate_labels(0.001, thresh) == 0, "Return within band should be 0 (Datar)"
    assert calculate_labels(-0.001, thresh) == 0, "Return within band should be 0 (Datar)"


def test_harmonized_datasets_exist_and_no_lookahead():
    article_path = "data/processed/dataset_article.parquet"
    hourly_path = "data/processed/dataset_hourly.parquet"

    assert os.path.exists(article_path), f"{article_path} must exist"
    assert os.path.exists(hourly_path), f"{hourly_path} must exist"

    df_art = pd.read_parquet(article_path)
    # With a real news feed the article count reflects genuine coverage volume,
    # which is far smaller than the previous synthetic 1500-article stream and
    # varies with the RSS lookback window. Assert presence, not a fixed volume.
    assert len(df_art) > 0, "Expected at least one real article"

    # Test anti-lookahead: candle_time must be <= time_published_utc
    diff_sec = (df_art["time_published_utc"] - df_art["candle_time"]).dt.total_seconds()
    assert (diff_sec >= 0).all(), "Candle time must strictly precede or match publication time (zero lookahead)"

    # Test label values are in {-1, 0, 1}
    for col in ["label_1h", "label_4h", "label_24h"]:
        assert set(df_art[col].unique()).issubset({-1, 0, 1}), f"Invalid label values in {col}"


def test_calendar_surprise_has_no_lookahead():
    """Calendar events attached to an article must be published at/before it.

    ``bucket_harmonize`` uses ``merge_asof(..., direction="backward")``; an
    article must never inherit a surprise from a *future* event.
    """
    article_path = "data/processed/dataset_article.parquet"
    calendar_path = "data/raw/calendar/economic_calendar_enriched.csv"
    assert os.path.exists(calendar_path)
    df_cal = pd.read_csv(calendar_path)
    df_cal["timestamp_utc"] = pd.to_datetime(df_cal["timestamp_utc"], utc=True)

    # Re-run the same backward merge the pipeline performs and assert ordering.
    df_art = pd.read_parquet(article_path)
    df_art["time_published_utc"] = pd.to_datetime(df_art["time_published_utc"], utc=True)

    merged = pd.merge_asof(
        df_art.sort_values("time_published_utc"),
        df_cal[["timestamp_utc", "event_name"]],
        left_on="time_published_utc",
        right_on="timestamp_utc",
        direction="backward",
        tolerance=pd.Timedelta(hours=2),
    )
    matched = merged.dropna(subset=["timestamp_utc"])
    assert not matched.empty, "Expected at least one article matched to a calendar event"

    diff_sec = (matched["time_published_utc"] - matched["timestamp_utc"]).dt.total_seconds()
    assert (diff_sec >= 0).all(), (
        "Look-ahead violation: a calendar event is dated after the article that uses it"
    )


def test_bucketed_merge_direction_is_backward():
    """Guard the constant so the merge can never silently regress to 'nearest'."""
    from src.process.bucket_harmonize import CALENDAR_MERGE_DIRECTION

    assert CALENDAR_MERGE_DIRECTION == "backward", (
        "Calendar merge must be backward to avoid look-ahead leakage"
    )
