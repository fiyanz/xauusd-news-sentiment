"""Unit tests for data acquisition and validation."""

import json
import os
import pandas as pd
import pytest


def test_complete_price_data_exists_and_utc():
    path = "data/raw/price/xauusd_h1_complete.csv"
    assert os.path.exists(path), f"File {path} does not exist"

    df = pd.read_csv(path)
    assert len(df) > 90000, "Price dataset should contain extensive historical records"
    assert "time" in df.columns
    assert "close" in df.columns

    # Verify time is UTC formatted
    first_time = str(df["time"].iloc[0])
    last_time = str(df["time"].iloc[-1])
    assert "+00:00" in first_time or "UTC" in first_time
    assert "+00:00" in last_time or "UTC" in last_time

    # Verify monotonically increasing
    dt_series = pd.to_datetime(df["time"], utc=True)
    assert dt_series.is_monotonic_increasing, "Timestamps must be monotonically increasing"


def test_calendar_enriched_structure():
    path = "data/raw/calendar/economic_calendar_enriched.csv"
    assert os.path.exists(path), f"File {path} does not exist"

    df = pd.read_csv(path)
    assert len(df) >= 700, "Calendar should contain all historical events"

    expected_cols = [
        "timestamp_utc",
        "currency",
        "event_name",
        "actual",
        "forecast",
        "previous",
        "surprise_val",
        "z_score",
    ]
    for col in expected_cols:
        assert col in df.columns, f"Missing column {col} in enriched calendar"

    # Verify surprise = actual - previous calculation. Consensus forecasts are
    # unavailable from keyless sources, so surprise uses the documented fallback
    # method (actual_minus_previous); forecast is null.
    assert df["forecast"].isna().all(), "forecast must be null (no keyless consensus source)"
    comparable = df.dropna(subset=["actual", "previous", "surprise_val"])
    assert not comparable.empty, "Expected at least some rows with actual/previous/surprise"
    diff = (comparable["actual"] - comparable["previous"] - comparable["surprise_val"]).abs()
    assert (diff < 1e-3).all(), "Surprise value must equal actual - previous"
    assert (comparable["surprise_method"] == "actual_minus_previous").all()

    # Simulated rows must not carry invented numbers.
    sim = df[df["is_simulated"] == True]  # noqa: E712
    for col in ["actual", "forecast", "previous", "surprise_val", "z_score"]:
        assert sim[col].isna().all(), f"Simulated rows must have null {col}"


def test_news_sentiment_feed():
    path = "data/raw/news/news_sentiment_feed.json"
    assert os.path.exists(path), f"File {path} does not exist"

    with open(path, "r") as f:
        payload = json.load(f)
    articles = payload["articles"] if isinstance(payload, dict) else payload
    df = pd.DataFrame(articles)
    assert len(df) > 0, "Should have real news articles from RSS feeds"
    assert "overall_sentiment_score" in df.columns
    assert (df["overall_sentiment_score"] >= -1.0).all()
    assert (df["overall_sentiment_score"] <= 1.0).all()

    # Provenance: real URLs only, method recorded.
    assert not df["url"].astype(str).str.contains("example.com").any(), "example.com is forbidden"
    assert (df["sentiment_method"] == "vader").all(), "sentiment_method must be 'vader'"
    assert (df["source_feed"].astype(str).str.len() > 0).all()
