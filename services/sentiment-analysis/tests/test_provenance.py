"""Provenance contract tests (F1).

Guarantees that no synthetic-looking number is presented as a real measurement:
- the enriched calendar carries source / is_simulated columns and never mixes
  unmarked synthetic values,
- the news feed contains real article URLs (no example.com) and records the
  sentiment method,
- the bucketed feature table records its data source and generation time.
"""

import json
import os

import pandas as pd
import pytest


CALENDAR_CSV = "data/raw/calendar/economic_calendar_enriched.csv"
NEWS_JSON = "data/raw/news/news_sentiment_feed.json"
BUCKETED_PARQUET = "data/processed/bucketed_features.parquet"
PROVENANCE_JSON = "data/processed/provenance.json"


def test_calendar_has_provenance_columns():
    assert os.path.exists(CALENDAR_CSV), f"{CALENDAR_CSV} must exist"
    df = pd.read_csv(CALENDAR_CSV)

    for col in ["source", "forecast_source", "surprise_method", "is_simulated"]:
        assert col in df.columns, f"Missing provenance column {col} in calendar"

    # Rows claiming to be real must name a real source.
    real = df[df["is_simulated"] == False]  # noqa: E712
    assert real["source"].notna().all(), "Real calendar rows must have a non-null source"
    assert (real["source"].astype(str).str.len() > 0).all(), "Real calendar rows must name a source"
    assert not real["source"].astype(str).eq("simulated").any(), "Real rows cannot be labelled simulated"

    # Simulated rows must never carry invented numeric values.
    sim = df[df["is_simulated"] == True]  # noqa: E712
    for col in ["actual", "forecast", "previous", "surprise_val", "z_score"]:
        assert sim[col].isna().all(), f"Simulated rows must have null {col}, found values"

    # No consensus forecast source exists keyless: forecast must be null and the
    # surprise must use the documented fallback method.
    assert df["forecast"].isna().all(), "forecast must be null (no keyless consensus source)"
    real_with_prev = df[(df["is_simulated"] == False) & df["previous"].notna()]  # noqa: E712
    assert (real_with_prev["surprise_method"] == "actual_minus_previous").all(), (
        "surprise_method must be actual_minus_previous when a previous value exists"
    )
    diff = (real_with_prev["actual"] - real_with_prev["previous"] - real_with_prev["surprise_val"]).abs()
    assert (diff < 1e-3).all(), "surprise_val must equal actual - previous"


def test_calendar_has_real_actuals_from_public_sources():
    df = pd.read_csv(CALENDAR_CSV)
    real = df[df["is_simulated"] == False]  # noqa: E712
    assert len(real) > 500, f"Expected mostly real calendar rows, got {len(real)}"

    sources = real["source"].astype(str)
    assert sources.str.contains("bls_api_v2").any(), "Expected BLS-sourced actuals"
    assert sources.str.contains("fred_csv").any(), "Expected FRED-sourced actuals"


def test_news_has_no_synthetic_urls_and_records_method():
    assert os.path.exists(NEWS_JSON), f"{NEWS_JSON} must exist"
    with open(NEWS_JSON, "r") as f:
        payload = json.load(f)

    articles = payload["articles"] if isinstance(payload, dict) else payload
    assert len(articles) > 0, "News feed should contain real articles"

    df = pd.DataFrame(articles)
    for col in ["source_feed", "source_url", "sentiment_method"]:
        assert col in df.columns, f"Missing provenance column {col} in news feed"

    urls = df["url"].astype(str)
    assert not urls.str.contains("example.com").any(), "example.com placeholder URLs are forbidden"
    assert urls.str.startswith("http").all(), "Every article must carry a real URL"

    assert (df["source_url"].astype(str).str.startswith("http")).all(), "source_url must be a real URL"
    assert (df["sentiment_method"] == "vader").all(), "sentiment_method must be 'vader'"
    assert (df["source_feed"].astype(str).str.len() > 0).all(), "source_feed must be recorded"

    scores = df["overall_sentiment_score"].astype(float)
    assert scores.between(-1.0, 1.0).all(), "VADER compound scores must be within [-1, 1]"
    assert set(df["overall_sentiment_label"].unique()).issubset({"Bullish", "Bearish", "Neutral"})


def test_news_status_envelope():
    with open(NEWS_JSON, "r") as f:
        payload = json.load(f)
    if isinstance(payload, dict):
        assert payload.get("status") in {"ok", "unavailable"}
        assert isinstance(payload.get("articles"), list)


def test_bucketed_features_have_provenance_columns():
    assert os.path.exists(BUCKETED_PARQUET), f"{BUCKETED_PARQUET} must exist"
    df = pd.read_parquet(BUCKETED_PARQUET)

    for col in ["data_source", "generated_at"]:
        assert col in df.columns, f"Missing provenance column {col} in bucketed features"
    assert df["data_source"].notna().all() and (df["data_source"].astype(str).str.len() > 0).all()
    assert df["generated_at"].notna().all()


def test_schema_lock_columns_preserved():
    df = pd.read_parquet(BUCKETED_PARQUET)
    required = [
        "time_bucket",
        "ret_4h",
        "ret_24h",
        "vol_pre",
        "z_score",
        "surprise_val",
        "sentiment_score",
        "split",
        "p0",
    ]
    for col in required:
        assert col in df.columns, f"Schema lock broken: missing {col}"
    assert any(c.startswith("topic_") for c in df.columns)
    assert any(c.startswith("sentiment_x_") for c in df.columns)
    assert any(c.startswith("macro_") for c in df.columns)
    assert any(c.startswith("session_") for c in df.columns)


def test_provenance_manifest_written():
    assert os.path.exists(PROVENANCE_JSON), f"{PROVENANCE_JSON} must exist"
    with open(PROVENANCE_JSON, "r") as f:
        manifest = json.load(f)

    artifacts = manifest.get("artifacts", {})
    assert artifacts, "provenance manifest must list artifacts"
    for artifact, entry in artifacts.items():
        assert "source" in entry, f"{artifact} provenance missing 'source'"
        assert "is_simulated" in entry, f"{artifact} provenance missing 'is_simulated'"

    # The manifest must not claim everything is simulated when real data exists.
    assert not manifest.get("is_simulated", True), "Manifest should not mark real artifacts as simulated"


def test_carry_forward_surprise_is_real_not_fabricated():
    """Buckets without a real event carry the last released surprise.

    Anti-fabrication guard: the carry-forward value must be a real released
    surprise (matching an event in the calendar), not an invented 0.0, and its
    age is reported so stale values are distinguishable from a fresh event.
    """
    df = pd.read_parquet(BUCKETED_PARQUET)
    if "has_event" not in df.columns:
        pytest.skip("has_event column not present")

    no_event = df[df["has_event"] == 0]
    if no_event.empty:
        pytest.skip("All buckets carry a real event")

    # Carry-forward: surprise is filled with the last released event's value.
    # Buckets before the first real release legitimately have no surprise.
    filled = no_event["surprise_val"].notna()
    assert filled.mean() > 0.9, "most no-event buckets must carry the last released surprise"
    assert no_event.loc[filled, "z_score"].notna().all(), (
        "Buckets without a real event must carry the last released z_score"
    )

    # The carried value must be a real released surprise, not a fabricated 0.0.
    cal = pd.read_csv(CALENDAR_CSV)
    real_surprises = set(cal["surprise_val"].dropna().round(4).tolist())
    for v in no_event["surprise_val"].dropna().tolist():
        assert round(float(v), 4) in real_surprises, (
            f"Carry-forward surprise {v} is not a released event value"
        )

    # Age must be reported so stale values are distinguishable.
    if "surprise_age_hours" in no_event.columns:
        assert no_event.loc[filled, "surprise_age_hours"].notna().all()
        assert (no_event.loc[filled, "surprise_age_hours"] >= 0).all()
